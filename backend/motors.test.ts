import { describe, expect, it } from 'vitest';
import { Pid, VelocityMotor, type MotorSpec } from './motors';

const DT = 1 / 240;
const spec: MotorSpec = { maxTorque: 0.5, maxVelocity: 30, kp: 0.05, ki: 0.1, kd: 0 };

/** عجلة بسيطة: J·dω/dt = τ − b·ω */
function simulate(motor: VelocityMotor, seconds: number, J = 0.01, b = 0.001) {
  let w = 0;
  let maxTorque = 0;
  for (let i = 0; i < seconds / DT; i++) {
    const tau = motor.update(w, DT);
    maxTorque = Math.max(maxTorque, Math.abs(tau));
    w += ((tau - b * w) / J) * DT;
  }
  return { w, maxTorque };
}

describe('Pid', () => {
  it('proportional only: output = kp * error', () => {
    const pid = new Pid({ kp: 2, ki: 0, kd: 0 });
    expect(pid.update(3, DT, 100)).toBeCloseTo(6, 9);
  });

  it('clamps the output to the limit', () => {
    const pid = new Pid({ kp: 100, ki: 0, kd: 0 });
    expect(pid.update(5, DT, 2)).toBe(2);
    expect(pid.update(-5, DT, 2)).toBe(-2);
  });

  it('does not wind up while saturated', () => {
    const pid = new Pid({ kp: 100, ki: 50, kd: 0 });
    for (let i = 0; i < 1000; i++) pid.update(5, DT, 2); // مشبع لفترة طويلة
    // بعد انعكاس الخطأ يجب أن يخرج من التشبع فوراً لا بعد تفريغ تكامل ضخم
    expect(pid.update(-5, DT, 2)).toBeLessThan(0);
  });
});

describe('VelocityMotor', () => {
  it('converges to the target velocity', () => {
    const m = new VelocityMotor('m', spec);
    m.setTarget(10);
    const { w } = simulate(m, 4);
    expect(Math.abs(w - 10)).toBeLessThan(0.2);
  });

  it('never exceeds maxTorque', () => {
    const m = new VelocityMotor('m', spec);
    m.setTarget(30);
    const { maxTorque } = simulate(m, 2);
    expect(maxTorque).toBeLessThanOrEqual(spec.maxTorque + 1e-12);
  });

  it('clamps targets to ±maxVelocity and rejects NaN', () => {
    const m = new VelocityMotor('m', spec);
    m.setTarget(1000);
    expect(m.target).toBe(30);
    m.setTarget(-1000);
    expect(m.target).toBe(-30);
    m.setTarget(Number.NaN);
    expect(m.target).toBe(0);
  });

  it('available torque falls to zero at the no-load speed (motor curve)', () => {
    const m = new VelocityMotor('m', spec);
    m.setTarget(30);
    expect(m.update(30, DT)).toBeCloseTo(0, 9);
    // الكبح (عزم عكس الحركة) يبقى كاملاً
    m.setTarget(-30);
    expect(m.update(30, DT)).toBeCloseTo(-0.5, 9);
  });

  it('reset clears target and torque', () => {
    const m = new VelocityMotor('m', spec);
    m.setTarget(10);
    m.update(0, DT);
    m.reset();
    expect(m.target).toBe(0);
    expect(m.torque).toBe(0);
  });
});
