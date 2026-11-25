import { describe, expect, it } from 'vitest';
import { AdaptiveQuality, MAX_QUALITY } from './quality';

// قيم أُس 2 كي تكتمل نافذة الثانية الواحدة بدقة دون بقايا عشرية
const FAST = 15.625; // 64fps
const SLOW = 62.5; // 16fps

/** يغذي الكائن بإطارات ثابتة لمدة seconds ويرجع قائمة التغييرات. */
function run(q: AdaptiveQuality, frameMs: number, seconds: number): number[] {
  const changes: number[] = [];
  const frames = Math.round((seconds * 1000) / frameMs);
  for (let i = 0; i < frames; i++) {
    const r = q.onFrame(frameMs / 1000);
    if (r !== null) changes.push(r);
  }
  return changes;
}

describe('AdaptiveQuality', () => {
  it('clamps the initial level', () => {
    expect(new AdaptiveQuality(99).current).toBe(MAX_QUALITY);
    expect(new AdaptiveQuality(-5).current).toBe(0);
  });

  it('downgrades when frames are slow', () => {
    const q = new AdaptiveQuality(3);
    const changes = run(q, SLOW, 2.5);
    expect(changes.length).toBeGreaterThan(0);
    expect(q.current).toBeLessThan(3);
  });

  it('never goes below level 0', () => {
    const q = new AdaptiveQuality(1);
    run(q, SLOW, 20);
    expect(q.current).toBe(0);
  });

  it('upgrades only after sustained stability', () => {
    const q = new AdaptiveQuality(1, { upgradeAfterSeconds: 5 });
    expect(run(q, FAST, 3)).toEqual([]); // مبكر جداً
    expect(run(q, FAST, 4)).toEqual([2]);
  });

  it('backs off after a failed upgrade', () => {
    const q = new AdaptiveQuality(1, { upgradeAfterSeconds: 3 });
    run(q, FAST, 4); // ترقية إلى 2
    expect(q.current).toBe(2);
    run(q, SLOW, 1); // بطء مباشرة بعد الترقية: تراجع وتضاعف التهدئة
    expect(q.current).toBe(1);
    // التهدئة صارت 6 ثوانٍ، فلا ترقية بعد 4 ثوانٍ مستقرة
    expect(run(q, FAST, 4)).toEqual([]);
    expect(q.current).toBe(1);
  });

  it('does nothing in manual mode, and resumes in auto mode', () => {
    const q = new AdaptiveQuality(3);
    q.setManual(2);
    run(q, SLOW, 5);
    expect(q.current).toBe(2);
    q.setManual(null);
    run(q, SLOW, 3);
    expect(q.current).toBeLessThan(2);
  });

  it('ignores huge frame gaps (tab switch)', () => {
    const q = new AdaptiveQuality(3);
    expect(q.onFrame(5)).toBeNull();
    expect(q.current).toBe(3);
  });
});
