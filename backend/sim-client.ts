import type { MainToSim, RobotBodyInfo, SimToMain } from './protocol';
import type { RobotGeometry, RobotSpec, RobotTelemetry } from './robot';
import { createStateBuffer } from './protocol';
import { SharedStateReader } from './shared-state';
import { DEFAULT_WORLD_CONFIG, type BodyDescriptor, type BodyId, type WorldConfig } from './world';

export interface SimStats {
  stepMs: number;
  stepsPerSecond: number;
  time: number;
}

export interface RobotInfo {
  robotId: number;
  bodies: RobotBodyInfo[];
  motorIds: string[];
  geometry: RobotGeometry;
}

/** واجهة الصفحة للتحدث مع Sim Worker. */
export class SimClient {
  readonly config: Readonly<WorldConfig>;
  readonly reader: SharedStateReader;
  onStats: ((s: SimStats) => void) | null = null;
  onError: ((message: string) => void) | null = null;
  onTelemetry: ((robots: RobotTelemetry[]) => void) | null = null;

  private readonly worker: Worker;
  private nextRequest = 1;
  private readonly pending = new Map<number, (r: { id: BodyId; slot: number }) => void>();
  private readonly pendingRobots = new Map<
    number,
    { resolve: (r: RobotInfo) => void; reject: (e: Error) => void }
  >();

  private constructor(worker: Worker, config: WorldConfig, buffer: SharedArrayBuffer) {
    this.worker = worker;
    this.config = config;
    this.reader = new SharedStateReader(buffer, config.maxBodies);
  }

  static async create(overrides: Partial<WorldConfig> = {}): Promise<SimClient> {
    if (typeof SharedArrayBuffer === 'undefined' || !self.crossOriginIsolated) {
      throw new Error('SharedArrayBuffer غير متاح: تحقق من ترويسات COOP/COEP (انظر README.md)');
    }
    const config: WorldConfig = { ...DEFAULT_WORLD_CONFIG, ...overrides };
    const buffer = createStateBuffer(config.maxBodies);
    const worker = new Worker(new URL('./sim.worker.ts', import.meta.url), { type: 'module' });
    const client = new SimClient(worker, config, buffer);

    await new Promise<void>((resolve, reject) => {
      worker.onmessage = (e: MessageEvent<SimToMain>) => {
        if (e.data.type === 'ready') {
          worker.onmessage = (ev: MessageEvent<SimToMain>) => client.dispatch(ev.data);
          resolve();
        } else if (e.data.type === 'error') {
          reject(new Error(e.data.message));
        }
      };
      worker.onerror = (ev) => reject(new Error(ev.message || 'worker failed to start'));
      client.send({ type: 'init', config, stateBuffer: buffer });
    });
    return client;
  }

  addBody(descriptor: BodyDescriptor): Promise<{ id: BodyId; slot: number }> {
    const requestId = this.nextRequest++;
    return new Promise((resolve) => {
      this.pending.set(requestId, resolve);
      this.send({ type: 'addBody', requestId, descriptor });
    });
  }

  /** يضيف روبوتاً؛ يُرفض الوعد إن كانت المواصفات غير صالحة. */
  addRobot(spec: RobotSpec): Promise<RobotInfo> {
    const requestId = this.nextRequest++;
    return new Promise((resolve, reject) => {
      this.pendingRobots.set(requestId, { resolve, reject });
      this.send({ type: 'addRobot', requestId, spec });
    });
  }
  removeRobot(robotId: number): void {
    this.send({ type: 'removeRobot', robotId });
  }
  /** أهداف سرعة المحركات (راديان/ث) بحسب معرّف المحرك. */
  setMotorTargets(robotId: number, targets: Record<string, number>): void {
    this.send({ type: 'setMotorTargets', robotId, targets });
  }

  removeBody(id: BodyId): void {
    this.send({ type: 'removeBody', id });
  }
  setSpeed(multiplier: number): void {
    this.send({ type: 'setSpeed', multiplier });
  }
  pause(): void {
    this.send({ type: 'pause' });
  }
  resume(): void {
    this.send({ type: 'resume' });
  }
  stepOnce(): void {
    this.send({ type: 'stepOnce' });
  }
  reset(): void {
    this.send({ type: 'reset' });
  }
  dispose(): void {
    this.send({ type: 'dispose' });
  }

  private send(msg: MainToSim): void {
    this.worker.postMessage(msg);
  }

  private dispatch(msg: SimToMain): void {
    switch (msg.type) {
      case 'bodyAdded': {
        const resolve = this.pending.get(msg.requestId);
        this.pending.delete(msg.requestId);
        resolve?.({ id: msg.id as BodyId, slot: msg.slot });
        return;
      }
      case 'stats':
        this.onStats?.({ stepMs: msg.stepMs, stepsPerSecond: msg.stepsPerSecond, time: msg.time });
        return;
      case 'robotAdded': {
        const p = this.pendingRobots.get(msg.requestId);
        this.pendingRobots.delete(msg.requestId);
        p?.resolve({ robotId: msg.robotId, bodies: msg.bodies, motorIds: msg.motorIds, geometry: msg.geometry });
        return;
      }
      case 'robotFailed': {
        const p = this.pendingRobots.get(msg.requestId);
        this.pendingRobots.delete(msg.requestId);
        p?.reject(new Error(msg.message));
        return;
      }
      case 'telemetry':
        this.onTelemetry?.(msg.robots);
        return;
      case 'error':
        this.onError?.(msg.message);
        return;
      case 'ready':
        return;
    }
  }
}
