import { describe, expect, it } from 'vitest';
import { FLOATS_PER_BODY } from '../../backend/protocol';
import { SnapshotInterpolator } from './interpolator';

function snap(bodies: Array<[number, number, number, number, number, number, number]>): Float32Array {
  const a = new Float32Array(bodies.length * FLOATS_PER_BODY);
  bodies.forEach((b, i) => a.set(b, i * FLOATS_PER_BODY));
  return a;
}
const ID: [number, number, number, number] = [0, 0, 0, 1];

describe('SnapshotInterpolator', () => {
  it('returns 0 before any snapshot', () => {
    const it = new SnapshotInterpolator(4);
    expect(it.sample(1, new Float32Array(4 * FLOATS_PER_BODY))).toBe(0);
  });

  it('interpolates position linearly between two snapshots', () => {
    const it = new SnapshotInterpolator(4);
    const out = new Float32Array(4 * FLOATS_PER_BODY);
    it.push(snap([[0, 0, 0, ...ID]]), 1, 0);
    it.push(snap([[10, 0, 0, ...ID]]), 1, 10);
    // renderStep يبدأ عند 0 بعد أول دفعة، ثم يقفز إلى older=0 ويتقدم 5 خطوات
    expect(it.sample(5, out)).toBe(1);
    expect(out[0]).toBeCloseTo(5, 5);
    expect(it.sample(5, out)).toBe(1);
    expect(out[0]).toBeCloseTo(10, 5);
  });

  it('never extrapolates past the newest snapshot', () => {
    const it = new SnapshotInterpolator(2);
    const out = new Float32Array(2 * FLOATS_PER_BODY);
    it.push(snap([[0, 0, 0, ...ID]]), 1, 0);
    it.push(snap([[4, 0, 0, ...ID]]), 1, 4);
    it.sample(1000, out);
    expect(out[0]).toBeCloseTo(4, 5);
  });

  it('snaps to the newest snapshot when advance is 0 (paused)', () => {
    const it = new SnapshotInterpolator(2);
    const out = new Float32Array(2 * FLOATS_PER_BODY);
    it.push(snap([[0, 0, 0, ...ID]]), 1, 0);
    it.push(snap([[8, 0, 0, ...ID]]), 1, 8);
    it.sample(0, out);
    expect(out[0]).toBeCloseTo(8, 5);
  });

  it('ignores duplicate step counts', () => {
    const it = new SnapshotInterpolator(2);
    const out = new Float32Array(2 * FLOATS_PER_BODY);
    it.push(snap([[0, 0, 0, ...ID]]), 1, 0);
    it.push(snap([[8, 0, 0, ...ID]]), 1, 8);
    it.push(snap([[99, 0, 0, ...ID]]), 1, 8); // مكرر: يُهمل
    it.sample(0, out);
    expect(out[0]).toBeCloseTo(8, 5);
  });

  it('does not interpolate a newly created body from NaN', () => {
    const it = new SnapshotInterpolator(4);
    const out = new Float32Array(4 * FLOATS_PER_BODY);
    it.push(snap([[0, 0, 0, ...ID]]), 1, 0);
    it.push(snap([[0, 0, 0, ...ID], [6, 0, 0, ...ID]]), 2, 4);
    it.sample(2, out);
    expect(out[FLOATS_PER_BODY]).toBeCloseTo(6, 5);
  });

  it('keeps removed bodies (NaN) as NaN', () => {
    const it = new SnapshotInterpolator(4);
    const out = new Float32Array(4 * FLOATS_PER_BODY);
    const nan = Number.NaN;
    it.push(snap([[1, 0, 0, ...ID]]), 1, 0);
    it.push(snap([[nan, nan, nan, nan, nan, nan, nan]]), 1, 4);
    it.sample(2, out);
    expect(Number.isNaN(out[0])).toBe(true);
  });

  it('resets when the step counter goes backwards (simulation reset)', () => {
    const it = new SnapshotInterpolator(2);
    const out = new Float32Array(2 * FLOATS_PER_BODY);
    it.push(snap([[0, 0, 0, ...ID]]), 1, 100);
    it.push(snap([[8, 0, 0, ...ID]]), 1, 110);
    it.push(snap([[3, 0, 0, ...ID]]), 1, 0);
    it.sample(1, out);
    expect(out[0]).toBeCloseTo(3, 5);
  });

  it('interpolates rotation along the shortest arc and stays normalized', () => {
    const it = new SnapshotInterpolator(2);
    const out = new Float32Array(2 * FLOATS_PER_BODY);
    // q و -q يمثلان نفس الدوران؛ يجب ألا يمر الاستكمال عبر الصفر
    it.push(snap([[0, 0, 0, 0, 0, 0, 1]]), 1, 0);
    it.push(snap([[0, 0, 0, 0, 0, 0, -1]]), 1, 10);
    it.sample(5, out);
    const len = Math.hypot(out[3]!, out[4]!, out[5]!, out[6]!);
    expect(len).toBeCloseTo(1, 5);
    expect(Math.abs(out[6]!)).toBeCloseTo(1, 5);
  });
});
