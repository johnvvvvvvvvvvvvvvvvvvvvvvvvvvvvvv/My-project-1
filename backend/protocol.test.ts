import { describe, expect, it } from 'vitest';
import {
  FLOATS_PER_BODY,
  HEADER_BYTES,
  computeStateLayout,
  createStateBuffer,
  publishHeader,
  readHeader,
} from './protocol';

describe('state layout', () => {
  it('computes sizes correctly', () => {
    const l = computeStateLayout(10);
    expect(l.bodiesByteOffset).toBe(HEADER_BYTES);
    expect(l.totalBytes).toBe(HEADER_BYTES + 10 * FLOATS_PER_BODY * 4);
  });

  it('rejects invalid sizes', () => {
    expect(() => computeStateLayout(0)).toThrow(RangeError);
    expect(() => computeStateLayout(1.5)).toThrow(RangeError);
  });

  it('allocates a SharedArrayBuffer of the right size', () => {
    expect(createStateBuffer(8).byteLength).toBe(computeStateLayout(8).totalBytes);
  });
});

describe('header seqlock', () => {
  it('round-trips published values', () => {
    const buf = createStateBuffer(4);
    publishHeader(buf, 3, 42);
    expect(readHeader(buf)).toEqual({ bodyCount: 3, stepCount: 42 });
  });

  it('returns null while a write is in progress', () => {
    const buf = createStateBuffer(4);
    Atomics.add(new Int32Array(buf, 0, 4), 0, 1); // تسلسل فردي = كتابة جارية
    expect(readHeader(buf)).toBeNull();
  });
});
