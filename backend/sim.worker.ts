/// <reference lib="webworker" />
import { FixedStepClock } from './clock';
import type { MainToSim, SimToMain } from './protocol';
import { Robot, robotGeometry, validateRobotSpec } from './robot';
import { RapierWorld } from './rapier-world';
import { SharedStateWriter } from './shared-state';
import type { BodyId, WorldConfig } from './world';

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const post = (msg: SimToMain): void => ctx.postMessage(msg);

let world: RapierWorld | null = null;
let writer: SharedStateWriter | null = null;
let clock: FixedStepClock | null = null;
let config: WorldConfig | null = null;
const robots = new Map<number, Robot>();
let nextRobotId = 1;
let lastTelemetry = 0;

let timer: ReturnType<typeof setTimeout> | null = null;
let lastNow = 0;
let statSteps = 0;
let statMs = 0;
let statStart = 0;

function tick(): void {
  const now = performance.now();
  const dt = (now - lastNow) / 1000;
  lastNow = now;

  if (world && writer && clock) {
    const n = clock.advance(dt);
    if (n > 0) {
      const t0 = performance.now();
      const dt = 1 / world.config.physicsHz;
      for (let i = 0; i < n; i++) {
        // المحركات تعمل بنفس تردد الفيزياء، قبل كل خطوة
        for (const robot of robots.values()) robot.update(world, dt);
        world.step();
      }
      world.writeState(writer);
      statMs += performance.now() - t0;
      statSteps += n;
    }
    if (robots.size > 0 && now - lastTelemetry >= 100) {
      lastTelemetry = now;
      post({ type: 'telemetry', robots: [...robots.values()].map((r) => r.telemetry(world!)) });
    }
    const elapsed = now - statStart;
    if (elapsed >= 500) {
      post({
        type: 'stats',
        stepMs: statSteps > 0 ? statMs / statSteps : 0,
        stepsPerSecond: (statSteps * 1000) / elapsed,
        time: world.time,
      });
      statSteps = 0;
      statMs = 0;
      statStart = now;
    }
  }
  timer = setTimeout(tick, 1);
}

function startLoop(): void {
  if (timer !== null) return;
  lastNow = performance.now();
  statStart = lastNow;
  timer = setTimeout(tick, 1);
}

async function handle(msg: MainToSim): Promise<void> {
  switch (msg.type) {
    case 'init': {
      config = msg.config;
      world = await RapierWorld.create(msg.config);
      writer = new SharedStateWriter(msg.stateBuffer, msg.config.maxBodies);
      writer.clearAll();
      clock = new FixedStepClock(1 / msg.config.physicsHz);
      post({ type: 'ready' });
      startLoop();
      return;
    }
    case 'addBody': {
      if (!world || !writer) throw new Error('not initialized');
      const body = world.addBody(msg.descriptor);
      world.writeState(writer);
      post({ type: 'bodyAdded', requestId: msg.requestId, id: body.id, slot: world.slotOf(body.id) ?? -1 });
      return;
    }
    case 'removeBody': {
      if (!world || !writer) return;
      world.removeBody(msg.id as BodyId);
      world.writeState(writer);
      return;
    }
    case 'addRobot': {
      if (!world || !writer) throw new Error('not initialized');
      try {
        const spec = validateRobotSpec(msg.spec);
        const robotId = nextRobotId++;
        const robot = Robot.build(world, spec, robotId);
        robots.set(robotId, robot);
        world.writeState(writer);
        post({
          type: 'robotAdded',
          requestId: msg.requestId,
          robotId,
          bodies: robot.bodies.map((b) => ({
            slot: world!.slotOf(b.id) ?? -1,
            role: b.role,
            shape: b.shape,
            color: b.color,
          })),
          motorIds: robot.motorIds,
          geometry: robotGeometry(spec),
        });
      } catch (e) {
        post({ type: 'robotFailed', requestId: msg.requestId, message: e instanceof Error ? e.message : String(e) });
      }
      return;
    }
    case 'removeRobot': {
      const robot = robots.get(msg.robotId);
      if (!robot || !world || !writer) return;
      robot.remove(world);
      robots.delete(msg.robotId);
      world.writeState(writer);
      return;
    }
    case 'setMotorTargets':
      robots.get(msg.robotId)?.setTargets(msg.targets);
      return;
    case 'setSpeed':
      clock?.setSpeed(msg.multiplier);
      return;
    case 'pause':
      clock?.pause();
      return;
    case 'resume':
      clock?.resume();
      return;
    case 'stepOnce':
      clock?.stepOnce();
      return;
    case 'reset': {
      if (!config || !writer) return;
      world?.dispose();
      robots.clear();
      world = await RapierWorld.create(config);
      writer.begin();
      writer.clearAll();
      writer.end(0, 0);
      clock?.reset();
      return;
    }
    case 'dispose': {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      world?.dispose();
      world = null;
      ctx.close();
      return;
    }
  }
}

// معالجة الرسائل بالتسلسل (init غير متزامن، وقد تصل رسائل قبل اكتماله)
let queue: Promise<void> = Promise.resolve();
ctx.onmessage = (e: MessageEvent<MainToSim>) => {
  queue = queue
    .then(() => handle(e.data))
    .catch((err: unknown) => {
      post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    });
};
