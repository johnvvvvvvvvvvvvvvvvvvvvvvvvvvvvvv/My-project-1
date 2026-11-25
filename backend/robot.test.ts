import { describe, expect, it } from 'vitest';
import { QUAT_IDENTITY, quatFromYaw, rotateVec3, yawOf } from './math';
import {
  DEFAULT_ROBOT_SPEC,
  Robot,
  RobotSpecError,
  diffDrive,
  parseRobotSpec,
  robotGeometry,
  validateRobotSpec,
} from './robot';
import { RapierWorld } from './rapier-world';
import { DEFAULT_WORLD_CONFIG, type WorldConfig } from './world';

describe('math helpers', () => {
  it('quatFromYaw/yawOf round-trip', () => {
    for (const yaw of [-2.5, -0.3, 0, 0.7, 3]) expect(yawOf(quatFromYaw(yaw))).toBeCloseTo(yaw, 9);
  });

  it('positive yaw turns +X toward -Z (left when facing +X)', () => {
    const f = rotateVec3(quatFromYaw(Math.PI / 2), { x: 1, y: 0, z: 0 });
    expect(f.x).toBeCloseTo(0, 9);
    expect(f.z).toBeCloseTo(-1, 9);
  });

  it('identity rotation keeps vectors', () => {
    expect(rotateVec3(QUAT_IDENTITY, { x: 1, y: 2, z: 3 })).toEqual({ x: 1, y: 2, z: 3 });
  });
});

describe('robot spec', () => {
  it('empty object gives the defaults', () => {
    expect(validateRobotSpec({})).toEqual(DEFAULT_ROBOT_SPEC);
  });

  it('partial override keeps other defaults', () => {
    const s = validateRobotSpec({ motor: { maxTorque: 0.4 }, chassis: { color: '#ff0000' } });
    expect(s.motor.maxTorque).toBe(0.4);
    expect(s.motor.kp).toBe(DEFAULT_ROBOT_SPEC.motor.kp);
    expect(s.chassis.color).toBe('#ff0000');
  });

  it('rejects unknown keys (typos), bad numbers and bad colors', () => {
    expect(() => validateRobotSpec({ motor: { maxTorqe: 1 } })).toThrow(RobotSpecError);
    expect(() => validateRobotSpec({ wheels: { radius: -1 } })).toThrow(RobotSpecError);
    expect(() => validateRobotSpec({ wheels: { radius: 'x' } })).toThrow(RobotSpecError);
    expect(() => validateRobotSpec({ chassis: { color: 'red' } })).toThrow(RobotSpecError);
    expect(() => validateRobotSpec({ casters: 'none' })).toThrow(RobotSpecError);
    expect(() => validateRobotSpec(null)).toThrow(RobotSpecError);
  });

  it('rejects clearance larger than the wheel diameter', () => {
    expect(() => validateRobotSpec({ chassis: { clearance: 0.5 } })).toThrow(RobotSpecError);
  });

  it('parseRobotSpec reports invalid JSON', () => {
    expect(() => parseRobotSpec('{oops')).toThrow(RobotSpecError);
    expect(parseRobotSpec('{"name":"X"}').name).toBe('X');
  });

  it('allows zero casters', () => {
    expect(validateRobotSpec({ casters: [] }).casters).toEqual([]);
  });
});

describe('diffDrive', () => {
  const g = robotGeometry(DEFAULT_ROBOT_SPEC as never);

  it('straight line: equal wheel speeds = v / r', () => {
    const { left, right } = diffDrive(0.5, 0, g);
    expect(left).toBeCloseTo(0.5 / g.wheelRadius, 9);
    expect(right).toBeCloseTo(left, 9);
  });

  it('spin in place: opposite speeds; positive w = right wheel faster (turn left)', () => {
    const { left, right } = diffDrive(0, 1, g);
    expect(right).toBeGreaterThan(0);
    expect(left).toBeCloseTo(-right, 9);
  });

  it('scales both wheels together when over the limit', () => {
    const a = diffDrive(0.5, 2, { ...g, maxWheelVelocity: 1e9 });
    const b = diffDrive(0.5, 2, { ...g, maxWheelVelocity: 10 });
    expect(Math.max(Math.abs(b.left), Math.abs(b.right))).toBeCloseTo(10, 9);
    expect(b.left / b.right).toBeCloseTo(a.left / a.right, 9);
  });
});

/* ---------------- تكاملي مع Rapier ---------------- */
const cfg: WorldConfig = { ...DEFAULT_WORLD_CONFIG, maxBodies: 64 };

async function scene() {
  const world = await RapierWorld.create(cfg);
  world.addBody({
    type: 'static',
    shape: { kind: 'plane' },
    transform: { position: { x: 0, y: 0, z: 0 }, rotation: { ...QUAT_IDENTITY } },
    friction: 0.6,
  });
  const robot = Robot.build(world, validateRobotSpec({}), 1);
  return { world, robot };
}

function run(world: RapierWorld, robot: Robot, seconds: number): void {
  const dt = 1 / cfg.physicsHz;
  for (let i = 0; i < seconds * cfg.physicsHz; i++) {
    robot.update(world, dt);
    world.step();
  }
}

describe('Robot (Rapier)', () => {
  it('builds chassis, two wheels and two casters, and settles on the ground', async () => {
    const { world, robot } = await scene();
    expect(robot.bodies).toHaveLength(5);
    expect(robot.motorIds).toEqual(['left', 'right']);
    run(world, robot, 1.5);
    const t = robot.telemetry(world);
    expect(t.y).toBeCloseTo(robotGeometry(robot.spec).chassisY, 1);
    expect(Math.abs(t.x)).toBeLessThan(0.05);
    world.dispose();
  });

  it('drives forward (+X) when both motors run forward', async () => {
    const { world, robot } = await scene();
    robot.setTargets({ left: 10, right: 10 });
    run(world, robot, 3);
    const t = robot.telemetry(world);
    expect(t.x).toBeGreaterThan(0.5);
    expect(Math.abs(t.z)).toBeLessThan(0.15);
    for (const m of t.motors) expect(Math.abs(m.torque)).toBeLessThanOrEqual(robot.spec.motor.maxTorque + 1e-9);
    world.dispose();
  });

  it('drives backward with negative targets', async () => {
    const { world, robot } = await scene();
    robot.setTargets({ left: -10, right: -10 });
    run(world, robot, 3);
    expect(robot.telemetry(world).x).toBeLessThan(-0.5);
    world.dispose();
  });

  it('turns left (positive yaw) when the right wheel is faster', async () => {
    const { world, robot } = await scene();
    robot.setTargets({ left: -6, right: 6 });
    run(world, robot, 3);
    const t = robot.telemetry(world);
    expect(t.yaw).toBeGreaterThan(0.3);
    expect(Math.hypot(t.x, t.z)).toBeLessThan(0.5); // يدور تقريباً في مكانه
    world.dispose();
  });

  it('respects spawn yaw and removes cleanly', async () => {
    const world = await RapierWorld.create(cfg);
    const robot = Robot.build(world, validateRobotSpec({ spawn: { x: 2, z: -1, yaw: 1 } }), 1);
    const t = robot.telemetry(world);
    expect(t.x).toBeCloseTo(2, 5);
    expect(t.z).toBeCloseTo(-1, 5);
    expect(t.yaw).toBeCloseTo(1, 5);
    robot.remove(world);
    expect(world.bodyCount).toBe(0);
    world.dispose();
  });
});
