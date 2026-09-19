import { describe, expect, it } from 'vitest';
import { FpsMeter, monotonicTimestamp } from '@/core/loop';

describe('monotonicTimestamp', () => {
  it('passes increasing timestamps through unchanged', () => {
    expect(monotonicTimestamp(100, 50)).toBe(100);
    expect(monotonicTimestamp(100.5, -1)).toBe(100.5);
  });

  it('nudges repeated or backwards timestamps forward', () => {
    expect(monotonicTimestamp(100, 100)).toBe(101);
    expect(monotonicTimestamp(90, 100)).toBe(101);
  });
});

describe('FpsMeter', () => {
  it('converges on the frame rate of a steady stream', () => {
    const meter = new FpsMeter(0.5);
    for (let i = 0; i <= 60; i++) meter.tick(i * (1000 / 30));
    expect(meter.fps).toBeCloseTo(30, 1);
  });

  it('ignores the first sample and zero-length intervals', () => {
    const meter = new FpsMeter();
    expect(meter.tick(0)).toBe(0);
    expect(meter.tick(0)).toBe(0);
    expect(meter.tick(20)).toBeCloseTo(50, 5);
  });
});
