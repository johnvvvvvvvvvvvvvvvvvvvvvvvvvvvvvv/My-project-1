import { quatFromYaw, yawOf, type Vec3 } from './math';
import { VelocityMotor, type MotorSpec } from './motors';
import type { BodyId, JointId, Shape, World } from './world';

/* ------------------------------------------------------------------ *
 * مواصفات الروبوت ذي العجلتين (قيادة تفاضلية).
 * الوحدات: متر، كيلوغرام، راديان. المحاور: +X أمام، +Y أعلى، +Z يمين.
 * ------------------------------------------------------------------ */
export interface RobotSpec {
  name: string;
  chassis: {
    length: number;
    height: number;
    width: number;
    mass: number;
    /** ارتفاع أسفل الهيكل عن الأرض. */
    clearance: number;
    friction: number;
    color: string;
  };
  wheels: {
    radius: number;
    width: number;
    mass: number;
    friction: number;
    /** إزاحة محور العجلتين على طول X من مركز الهيكل. */
    xOffset: number;
    color: string;
  };
  /** كرات حرة الدوران تسند الهيكل (بلا محركات). */
  casters: Array<{ x: number; radius: number }>;
  motor: MotorSpec;
  spawn: {
    x: number;
    z: number;
    /** ارتفاع إسقاط إضافي فوق الأرض. */
    y: number;
    /** اتجاه البدء (راديان)، الموجب = لليسار. */
    yaw: number;
  };
}

export const DEFAULT_ROBOT_SPEC: Readonly<RobotSpec> = Object.freeze({
  name: 'RoboSim Rover',
  chassis: { length: 0.3, height: 0.08, width: 0.18, mass: 1.0, clearance: 0.03, friction: 0.3, color: '#3b82f6' },
  wheels: { radius: 0.05, width: 0.03, mass: 0.15, friction: 1.5, xOffset: 0, color: '#e5e7eb' },
  casters: [
    { x: 0.12, radius: 0.025 },
    { x: -0.12, radius: 0.025 },
  ],
  motor: { maxTorque: 0.25, maxVelocity: 30, kp: 0.015, ki: 0.05, kd: 0 },
  spawn: { x: 0, z: 0, y: 0.01, yaw: 0 },
});

export class RobotSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RobotSpecError';
  }
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

function section(parent: Json, key: string, allowed: readonly string[]): Json {
  const v = parent[key];
  if (v === undefined) return {};
  if (!isObj(v)) throw new RobotSpecError(`الحقل "${key}" يجب أن يكون كائناً`);
  checkKeys(v, key, allowed);
  return v;
}

function checkKeys(obj: Json, path: string, allowed: readonly string[]): void {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) {
      throw new RobotSpecError(`حقل غير معروف "${path}.${k}" (الحقول المسموحة: ${allowed.join(', ')})`);
    }
  }
}

function num(sec: Json, path: string, key: string, def: number, min: number, max: number, minExclusive = false): number {
  const v = sec[key];
  if (v === undefined) return def;
  const bad = typeof v !== 'number' || !Number.isFinite(v) || v > max || (minExclusive ? v <= min : v < min);
  if (bad) {
    throw new RobotSpecError(`"${path}.${key}" يجب أن يكون رقماً ${minExclusive ? '>' : '≥'} ${min} و≤ ${max}`);
  }
  return v as number;
}

function color(sec: Json, path: string, def: string): string {
  const v = sec['color'];
  if (v === undefined) return def;
  if (typeof v !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(v)) {
    throw new RobotSpecError(`"${path}.color" يجب أن يكون بصيغة #rrggbb`);
  }
  return v;
}

/** يتحقق من مواصفات واردة من ملف ويكمل الناقص بالقيم الافتراضية. */
export function validateRobotSpec(input: unknown): RobotSpec {
  if (!isObj(input)) throw new RobotSpecError('المواصفات يجب أن تكون كائن JSON');
  checkKeys(input, '', ['name', 'chassis', 'wheels', 'casters', 'motor', 'spawn']);
  const d = DEFAULT_ROBOT_SPEC;

  const name = input['name'] === undefined ? d.name : input['name'];
  if (typeof name !== 'string' || name.length === 0 || name.length > 60) {
    throw new RobotSpecError('"name" يجب أن يكون نصاً من 1 إلى 60 حرفاً');
  }

  const c = section(input, 'chassis', ['length', 'height', 'width', 'mass', 'clearance', 'friction', 'color']);
  const w = section(input, 'wheels', ['radius', 'width', 'mass', 'friction', 'xOffset', 'color']);
  const m = section(input, 'motor', ['maxTorque', 'maxVelocity', 'kp', 'ki', 'kd']);
  const s = section(input, 'spawn', ['x', 'z', 'y', 'yaw']);

  let casters: Array<{ x: number; radius: number }>;
  const rawCasters = input['casters'];
  if (rawCasters === undefined) {
    casters = d.casters.map((k) => ({ ...k }));
  } else {
    if (!Array.isArray(rawCasters) || rawCasters.length > 4) {
      throw new RobotSpecError('"casters" يجب أن تكون قائمة من 0 إلى 4 عناصر');
    }
    casters = rawCasters.map((item, i) => {
      if (!isObj(item)) throw new RobotSpecError(`"casters[${i}]" يجب أن يكون كائناً`);
      checkKeys(item, `casters[${i}]`, ['x', 'radius']);
      return {
        x: num(item, `casters[${i}]`, 'x', 0, -5, 5),
        radius: num(item, `casters[${i}]`, 'radius', 0.025, 0, 0.5, true),
      };
    });
  }

  const spec: RobotSpec = {
    name,
    chassis: {
      length: num(c, 'chassis', 'length', d.chassis.length, 0, 5, true),
      height: num(c, 'chassis', 'height', d.chassis.height, 0, 2, true),
      width: num(c, 'chassis', 'width', d.chassis.width, 0, 5, true),
      mass: num(c, 'chassis', 'mass', d.chassis.mass, 0, 1000, true),
      clearance: num(c, 'chassis', 'clearance', d.chassis.clearance, 0, 1),
      friction: num(c, 'chassis', 'friction', d.chassis.friction, 0, 5),
      color: color(c, 'chassis', d.chassis.color),
    },
    wheels: {
      radius: num(w, 'wheels', 'radius', d.wheels.radius, 0, 1, true),
      width: num(w, 'wheels', 'width', d.wheels.width, 0, 1, true),
      mass: num(w, 'wheels', 'mass', d.wheels.mass, 0, 100, true),
      friction: num(w, 'wheels', 'friction', d.wheels.friction, 0, 5),
      xOffset: num(w, 'wheels', 'xOffset', d.wheels.xOffset, -5, 5),
      color: color(w, 'wheels', d.wheels.color),
    },
    casters,
    motor: {
      maxTorque: num(m, 'motor', 'maxTorque', d.motor.maxTorque, 0, 1000, true),
      maxVelocity: num(m, 'motor', 'maxVelocity', d.motor.maxVelocity, 0, 1000, true),
      kp: num(m, 'motor', 'kp', d.motor.kp, 0, 1e6),
      ki: num(m, 'motor', 'ki', d.motor.ki, 0, 1e6),
      kd: num(m, 'motor', 'kd', d.motor.kd, 0, 1e6),
    },
    spawn: {
      x: num(s, 'spawn', 'x', d.spawn.x, -1000, 1000),
      z: num(s, 'spawn', 'z', d.spawn.z, -1000, 1000),
      y: num(s, 'spawn', 'y', d.spawn.y, 0, 100),
      yaw: num(s, 'spawn', 'yaw', d.spawn.yaw, -100, 100),
    },
  };

  // الهيكل لا يجوز أن يتداخل مع العجلتين جانبياً، والعجلة أكبر من خلوص الهيكل
  if (spec.chassis.clearance >= spec.wheels.radius * 2) {
    throw new RobotSpecError('"chassis.clearance" يجب أن يكون أقل من قطر العجلة');
  }
  return spec;
}

export function parseRobotSpec(json: string): RobotSpec {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch (e) {
    throw new RobotSpecError(`ملف JSON غير صالح: ${e instanceof Error ? e.message : String(e)}`);
  }
  return validateRobotSpec(data);
}

/* ------------------------------------------------------------------ *
 * الهندسة المشتقة والقيادة التفاضلية
 * ------------------------------------------------------------------ */
export interface RobotGeometry {
  wheelRadius: number;
  /** المسافة بين مركزي العجلتين. */
  trackWidth: number;
  /** ارتفاع مركز الهيكل عن الأرض. */
  chassisY: number;
  /** أقصى سرعة عجلة (راديان/ثانية). */
  maxWheelVelocity: number;
}

const WHEEL_GAP = 0.005;

export function robotGeometry(spec: RobotSpec): RobotGeometry {
  const wheelZ = spec.chassis.width / 2 + spec.wheels.width / 2 + WHEEL_GAP;
  return {
    wheelRadius: spec.wheels.radius,
    trackWidth: wheelZ * 2,
    chassisY: spec.chassis.clearance + spec.chassis.height / 2,
    maxWheelVelocity: spec.motor.maxVelocity,
  };
}

/**
 * يحوّل سرعة خطية v (م/ث، موجب = أمام) وسرعة دوران w (راديان/ث، موجب = يسار)
 * إلى سرعتي العجلتين (راديان/ث). إن تجاوزت إحداهما الحد تُقلَّص الاثنتان معاً
 * بنفس النسبة فيبقى نصف قطر الانعطاف كما هو.
 */
export function diffDrive(v: number, w: number, g: RobotGeometry): { left: number; right: number } {
  let left = (v - (w * g.trackWidth) / 2) / g.wheelRadius;
  let right = (v + (w * g.trackWidth) / 2) / g.wheelRadius;
  const peak = Math.max(Math.abs(left), Math.abs(right));
  if (peak > g.maxWheelVelocity) {
    const k = g.maxWheelVelocity / peak;
    left *= k;
    right *= k;
  }
  return { left, right };
}

/* ------------------------------------------------------------------ *
 * الروبوت أثناء التشغيل
 * ------------------------------------------------------------------ */
export interface RobotBody {
  id: BodyId;
  role: 'chassis' | 'wheel-left' | 'wheel-right' | 'caster';
  shape: Shape;
  /** لون 0xRRGGBB. */
  color: number;
}

export interface MotorTelemetry {
  id: string;
  target: number;
  velocity: number;
  torque: number;
}

export interface RobotTelemetry {
  robotId: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  motors: MotorTelemetry[];
}

export const hexToNumber = (hex: string): number => Number.parseInt(hex.slice(1), 16);

interface MotorBinding {
  motor: VelocityMotor;
  joint: JointId;
}

export class Robot {
  readonly bodies: RobotBody[] = [];
  private readonly motors = new Map<string, MotorBinding>();
  private chassisId: BodyId | null = null;

  private constructor(
    readonly robotId: number,
    readonly spec: Readonly<RobotSpec>,
  ) {}

  get motorIds(): string[] {
    return [...this.motors.keys()];
  }

  /** يبني الأجسام والمفاصل في العالم. عند الفشل يُزيل ما أنشأه. */
  static build(world: World, spec: RobotSpec, robotId: number): Robot {
    const robot = new Robot(robotId, spec);
    try {
      robot.construct(world);
    } catch (e) {
      for (const b of robot.bodies) world.removeBody(b.id);
      throw e;
    }
    return robot;
  }

  /** أهداف سرعة المحركات (راديان/ث) بحسب المعرّف؛ المعرّفات المجهولة تُتجاهل. */
  setTargets(targets: Readonly<Record<string, number>>): void {
    for (const [id, value] of Object.entries(targets)) this.motors.get(id)?.motor.setTarget(value);
  }

  /** تُستدعى قبل كل خطوة فيزياء. */
  update(world: World, dt: number): void {
    for (const { motor, joint } of this.motors.values()) {
      world.applyJointTorque(joint, motor.update(world.jointVelocity(joint), dt));
    }
  }

  telemetry(world: World): RobotTelemetry {
    const t = this.chassisId === null ? undefined : world.getBodyTransform(this.chassisId);
    return {
      robotId: this.robotId,
      x: t?.position.x ?? 0,
      y: t?.position.y ?? 0,
      z: t?.position.z ?? 0,
      yaw: t ? yawOf(t.rotation) : 0,
      motors: [...this.motors.entries()].map(([id, { motor, joint }]) => ({
        id,
        target: motor.target,
        velocity: world.jointVelocity(joint),
        torque: motor.torque,
      })),
    };
  }

  remove(world: World): void {
    for (const b of this.bodies) world.removeBody(b.id);
    this.bodies.length = 0;
    this.motors.clear();
    this.chassisId = null;
  }

  private construct(world: World): void {
    const { spec } = this;
    const g = robotGeometry(spec);
    const { chassis, wheels, spawn } = spec;
    const yaw = spawn.yaw;
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    const rotation = quatFromYaw(yaw);

    /** من إحداثيات الهيكل المحلية (ارتفاعها عن الأرض) إلى العالم. */
    const place = (lx: number, ly: number, lz: number): Vec3 => ({
      x: spawn.x + lx * cos + lz * sin,
      y: spawn.y + ly,
      z: spawn.z - lx * sin + lz * cos,
    });
    const origin: Vec3 = { x: 0, y: 0, z: 0 };

    const chassisShape: Shape = {
      kind: 'box',
      halfExtents: { x: chassis.length / 2, y: chassis.height / 2, z: chassis.width / 2 },
    };
    const chassisBody = world.addBody({
      type: 'dynamic',
      shape: chassisShape,
      transform: { position: place(0, g.chassisY, 0), rotation },
      mass: chassis.mass,
      friction: chassis.friction,
      restitution: 0,
    });
    this.chassisId = chassisBody.id;
    this.bodies.push({ id: chassisBody.id, role: 'chassis', shape: chassisShape, color: hexToNumber(chassis.color) });

    const wheelZ = g.trackWidth / 2;
    const wheelShape: Shape = { kind: 'cylinder', halfHeight: wheels.width / 2, radius: wheels.radius, axis: 'z' };
    // المحور -Z في إطار الهيكل: الدوران الموجب = تقدم للأمام للعجلتين معاً
    const axis: Vec3 = { x: 0, y: 0, z: -1 };

    for (const [id, role, side] of [
      ['left', 'wheel-left', -1],
      ['right', 'wheel-right', 1],
    ] as const) {
      const wheel = world.addBody({
        type: 'dynamic',
        shape: wheelShape,
        transform: { position: place(wheels.xOffset, wheels.radius, side * wheelZ), rotation },
        mass: wheels.mass,
        friction: wheels.friction,
        restitution: 0,
      });
      this.bodies.push({ id: wheel.id, role, shape: wheelShape, color: hexToNumber(wheels.color) });
      const joint = world.addRevoluteJoint({
        bodyA: chassisBody.id,
        bodyB: wheel.id,
        anchorA: { x: wheels.xOffset, y: wheels.radius - g.chassisY, z: side * wheelZ },
        anchorB: origin,
        axis,
      });
      this.motors.set(id, { motor: new VelocityMotor(id, spec.motor), joint });
    }

    for (const c of spec.casters) {
      const shape: Shape = { kind: 'sphere', radius: c.radius };
      const caster = world.addBody({
        type: 'dynamic',
        shape,
        transform: { position: place(c.x, c.radius, 0), rotation },
        mass: 0.05,
        friction: 0,
        restitution: 0,
      });
      this.bodies.push({ id: caster.id, role: 'caster', shape, color: 0x888888 });
      world.addSphericalJoint({
        bodyA: chassisBody.id,
        bodyB: caster.id,
        anchorA: { x: c.x, y: c.radius - g.chassisY, z: 0 },
        anchorB: origin,
      });
    }
  }
}
