import type { RobotGeometry, RobotSpec, RobotTelemetry } from './robot';
import type { BodyDescriptor, Shape, WorldConfig } from './world';

/** جسم من أجسام الروبوت كما يراه الرسم. */
export interface RobotBodyInfo {
  slot: number;
  role: 'chassis' | 'wheel-left' | 'wheel-right' | 'caster';
  shape: Shape;
  color: number;
}

/* ------------------------------------------------------------------ *
 * الرسائل بين الصفحة (Main) وworker المحاكاة (Sim).
 * الحالة المتكررة (مواضع الأجسام) تنتقل عبر SharedArrayBuffer،
 * أما الرسائل أدناه فللتحكم والأحداث النادرة فقط.
 * ------------------------------------------------------------------ */
export type MainToSim =
  | { type: 'init'; config: WorldConfig; stateBuffer: SharedArrayBuffer }
  | { type: 'addBody'; requestId: number; descriptor: BodyDescriptor }
  | { type: 'removeBody'; id: number }
  | { type: 'addRobot'; requestId: number; spec: RobotSpec }
  | { type: 'removeRobot'; robotId: number }
  | { type: 'setMotorTargets'; robotId: number; targets: Record<string, number> }
  | { type: 'setSpeed'; multiplier: number }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'stepOnce' }
  | { type: 'reset' }
  | { type: 'dispose' };

export type SimToMain =
  | { type: 'ready' }
  | { type: 'bodyAdded'; requestId: number; id: number; slot: number }
  | { type: 'stats'; stepMs: number; stepsPerSecond: number; time: number }
  | {
      type: 'robotAdded';
      requestId: number;
      robotId: number;
      bodies: RobotBodyInfo[];
      motorIds: string[];
      geometry: RobotGeometry;
    }
  | { type: 'robotFailed'; requestId: number; message: string }
  | { type: 'telemetry'; robots: RobotTelemetry[] }
  | { type: 'error'; message: string };

/* ------------------------------------------------------------------ *
 * تخطيط الذاكرة المشتركة (Seqlock):
 *   [Int32 × HEADER_INTS][Float32 × maxBodies × FLOATS_PER_BODY]
 *   header[0] = sequence (فردي أثناء الكتابة، زوجي عند الاكتمال)
 *   header[1] = عدد الخانات المستخدمة
 *   header[2] = عدد الخطوات المنفذة
 * خانة فارغة (جسم محذوف) = كل قيمها NaN.
 * ------------------------------------------------------------------ */
export const HEADER_INTS = 4;
export const FLOATS_PER_BODY = 7; // px py pz qx qy qz qw
export const HEADER_BYTES = HEADER_INTS * Int32Array.BYTES_PER_ELEMENT;

export const HeaderIndex = { Sequence: 0, BodyCount: 1, StepCount: 2 } as const;

export interface StateLayout {
  maxBodies: number;
  headerBytes: number;
  bodiesByteOffset: number;
  totalBytes: number;
}

export function computeStateLayout(maxBodies: number): StateLayout {
  if (!Number.isInteger(maxBodies) || maxBodies <= 0) {
    throw new RangeError(`maxBodies must be a positive integer, got ${maxBodies}`);
  }
  const totalBytes = HEADER_BYTES + maxBodies * FLOATS_PER_BODY * Float32Array.BYTES_PER_ELEMENT;
  return { maxBodies, headerBytes: HEADER_BYTES, bodiesByteOffset: HEADER_BYTES, totalBytes };
}

export function createStateBuffer(maxBodies: number): SharedArrayBuffer {
  return new SharedArrayBuffer(computeStateLayout(maxBodies).totalBytes);
}

/** يكتب الترويسة بأسلوب Seqlock (يستخدمه الـWorker). */
export function publishHeader(buffer: SharedArrayBuffer, bodyCount: number, stepCount: number): void {
  const h = new Int32Array(buffer, 0, HEADER_INTS);
  Atomics.add(h, HeaderIndex.Sequence, 1);
  Atomics.store(h, HeaderIndex.BodyCount, bodyCount);
  Atomics.store(h, HeaderIndex.StepCount, stepCount);
  Atomics.add(h, HeaderIndex.Sequence, 1);
}

/** يقرأ الترويسة بشكل متسق؛ null إن كان الكاتب مشغولاً بعد عدة محاولات. */
export function readHeader(
  buffer: SharedArrayBuffer,
  maxAttempts = 8,
): { bodyCount: number; stepCount: number } | null {
  const h = new Int32Array(buffer, 0, HEADER_INTS);
  for (let i = 0; i < maxAttempts; i++) {
    const s1 = Atomics.load(h, HeaderIndex.Sequence);
    if (s1 & 1) continue;
    const bodyCount = Atomics.load(h, HeaderIndex.BodyCount);
    const stepCount = Atomics.load(h, HeaderIndex.StepCount);
    if (Atomics.load(h, HeaderIndex.Sequence) === s1) return { bodyCount, stepCount };
  }
  return null;
}
