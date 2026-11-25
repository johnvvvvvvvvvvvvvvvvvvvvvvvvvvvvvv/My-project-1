import type { Actuator, ActuatorLimits } from './devices';

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

export interface PidGains {
  kp: number;
  ki: number;
  kd: number;
}

/**
 * متحكم PID منفصل الزمن مع حماية من تراكم التكامل (Anti-windup):
 * لا يزداد التكامل إذا كان الخرج مشبعاً والخطأ يدفع أكثر نحو التشبع.
 */
export class Pid {
  private integral = 0;
  private prevError = 0;
  private hasPrev = false;

  constructor(readonly gains: Readonly<PidGains>) {}

  reset(): void {
    this.integral = 0;
    this.prevError = 0;
    this.hasPrev = false;
  }

  /** @param limit أقصى قيمة مطلقة للخرج */
  update(error: number, dt: number, limit: number): number {
    const { kp, ki, kd } = this.gains;
    const derivative = this.hasPrev && dt > 0 ? (error - this.prevError) / dt : 0;
    this.prevError = error;
    this.hasPrev = true;

    const candidate = this.integral + error * dt;
    const raw = kp * error + ki * candidate + kd * derivative;
    const out = clamp(raw, -limit, limit);
    if (out === raw || Math.sign(error) !== Math.sign(raw)) this.integral = candidate;
    return out;
  }
}

export interface MotorSpec {
  /** أقصى عزم عند السرعة صفر (نيوتن.متر). */
  maxTorque: number;
  /** السرعة بلا حمل (راديان/ثانية)؛ عندها يصير العزم المتاح صفراً. */
  maxVelocity: number;
  kp: number;
  ki: number;
  kd: number;
}

/**
 * محرك بتحكم سرعة (PID) مع نموذج محرك تيار مستمر مبسط:
 * العزم المتاح يتناقص خطياً مع السرعة (منحنى عزم-سرعة)، ويبقى كاملاً عند الكبح.
 */
export class VelocityMotor implements Actuator {
  readonly mode = 'velocity' as const;
  readonly limits: Readonly<ActuatorLimits>;
  private readonly pid: Pid;
  private targetVelocity = 0;
  private lastTorque = 0;

  constructor(
    readonly id: string,
    private readonly spec: Readonly<MotorSpec>,
  ) {
    this.limits = { maxTorque: spec.maxTorque, maxVelocity: spec.maxVelocity };
    this.pid = new Pid({ kp: spec.kp, ki: spec.ki, kd: spec.kd });
  }

  get target(): number {
    return this.targetVelocity;
  }

  /** آخر عزم طُبِّق (نيوتن.متر). */
  get torque(): number {
    return this.lastTorque;
  }

  setTarget(value: number): void {
    // قيمة غير صالحة (NaN) تُعامل كإيقاف بدل إفساد المحاكاة
    const v = Number.isFinite(value) ? value : 0;
    this.targetVelocity = clamp(v, -this.spec.maxVelocity, this.spec.maxVelocity);
  }

  reset(): void {
    this.pid.reset();
    this.targetVelocity = 0;
    this.lastTorque = 0;
  }

  /** يحسب العزم المطلوب من السرعة المقاسة (راديان/ثانية). */
  update(measuredVelocity: number, dt: number): number {
    const { maxTorque, maxVelocity } = this.spec;
    let torque = this.pid.update(this.targetVelocity - measuredVelocity, dt, maxTorque);

    // منحنى عزم-سرعة: عند الدفع في اتجاه الحركة يقل العزم المتاح
    if (torque * measuredVelocity > 0) {
      const available = maxTorque * (1 - Math.min(1, Math.abs(measuredVelocity) / maxVelocity));
      torque = clamp(torque, -available, available);
    }
    this.lastTorque = torque;
    return torque;
  }
}
