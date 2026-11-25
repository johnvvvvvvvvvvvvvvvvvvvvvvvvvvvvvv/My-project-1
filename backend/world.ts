import type { Transform, Vec3 } from './math';

export type BodyId = number & { readonly __brand: 'BodyId' };

export type Shape =
  | { kind: 'box'; halfExtents: Vec3 }
  | { kind: 'sphere'; radius: number }
  /** axis: محور الأسطوانة في إطار الجسم (الافتراضي y). العجلات تستخدم z. */
  | { kind: 'cylinder'; halfHeight: number; radius: number; axis?: 'x' | 'y' | 'z' }
  | { kind: 'plane' };

export type BodyType = 'static' | 'dynamic' | 'kinematic';

export interface BodyDescriptor {
  type: BodyType;
  shape: Shape;
  transform: Transform;
  mass?: number;
  friction?: number;
  restitution?: number;
}

export type JointId = number & { readonly __brand: 'JointId' };

/** مفصل دوّار: محور واحد؛ المرساتان والمحور بإحداثيات كل جسم المحلية (يجب أن تتوازى الأطر). */
export interface RevoluteJointDescriptor {
  bodyA: BodyId;
  bodyB: BodyId;
  anchorA: Vec3;
  anchorB: Vec3;
  axis: Vec3;
}

/** مفصل كروي (دوران حر حول نقطة)، يصلح لعجلة الكاستر. */
export interface SphericalJointDescriptor {
  bodyA: BodyId;
  bodyB: BodyId;
  anchorA: Vec3;
  anchorB: Vec3;
}

export interface Body {
  readonly id: BodyId;
  readonly descriptor: Readonly<BodyDescriptor>;
}

export interface Ray {
  origin: Vec3;
  direction: Vec3;
  maxDistance: number;
}

export interface RayHit {
  distance: number;
  bodyId: BodyId;
  point: Vec3;
  normal: Vec3;
}

/** إعدادات المحاكاة. الحتمية: نفس seed ونفس المدخلات = نفس النتائج. */
export interface WorldConfig {
  /** تردد الفيزياء بالهرتز (افتراضي 240). */
  physicsHz: number;
  gravity: Vec3;
  seed: number;
  maxBodies: number;
}

export const DEFAULT_WORLD_CONFIG: Readonly<WorldConfig> = Object.freeze({
  physicsHz: 240,
  gravity: { x: 0, y: -9.81, z: 0 },
  seed: 1,
  maxBodies: 4096,
});

/**
 * عقد محرك الفيزياء. أي محرك (Rapier, MuJoCo) ينفذ هذه الواجهة
 * فيمكن تبديله دون المساس ببقية النظام.
 */
export interface World {
  readonly config: Readonly<WorldConfig>;
  /** الزمن المحاكى بالثواني. */
  readonly time: number;
  addBody(descriptor: BodyDescriptor): Body;
  removeBody(id: BodyId): void;
  getBodyTransform(id: BodyId): Transform | undefined;
  addRevoluteJoint(descriptor: RevoluteJointDescriptor): JointId;
  addSphericalJoint(descriptor: SphericalJointDescriptor): JointId;
  /** سرعة B بالنسبة لـA حول محور المفصل (راديان/ثانية)، الموجب مع اتجاه المحور. */
  jointVelocity(id: JointId): number;
  /** عزم (نيوتن.متر) على B بمحور المفصل وعكسه على A، يُطبَّق لخطوة فيزياء واحدة. */
  applyJointTorque(id: JointId, torque: number): void;
  /** يتقدم خطوة ثابتة واحدة (1 / physicsHz). */
  step(): void;
  raycast(ray: Ray): RayHit | null;
  /** لقطة قابلة للتسلسل لحفظ/استعادة الحالة. */
  snapshot(): Uint8Array;
  restore(snapshot: Uint8Array): void;
  dispose(): void;
}
