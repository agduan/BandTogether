import { describe, expect, it } from 'vitest';
import { LatencyMeter, velocityToGain } from '@/audio/latencyMeter';
import type { AudioPlayedEvent } from '@/core/types';

const played = (frameT: number, detectT: number, audioT: number): AudioPlayedEvent => ({
  type: 'audio.played',
  frameT,
  detectT,
  audioT,
  source: 'drum.hit',
});

describe('LatencyMeter', () => {
  it('takes the first sample as-is and then smooths', () => {
    const m = new LatencyMeter(0.5);
    m.record(played(1000, 1020, 1030), 12);
    expect(m.stats).toEqual({ pipelineMs: 30, audioMs: 10, outputMs: 12, count: 1 });
    m.record(played(2000, 2020, 2070), 12);
    expect(m.stats.pipelineMs).toBe(50); // halfway from 30 to 70
    expect(m.stats.audioMs).toBe(30);
    expect(m.stats.count).toBe(2);
  });

  it('resets', () => {
    const m = new LatencyMeter();
    m.record(played(0, 1, 2));
    m.reset();
    expect(m.stats.count).toBe(0);
    expect(m.stats.pipelineMs).toBe(0);
  });
});

describe('velocityToGain', () => {
  it('keeps soft hits audible and clamps the range', () => {
    expect(velocityToGain(0)).toBeCloseTo(0.2, 6);
    expect(velocityToGain(1)).toBeCloseTo(1.0, 6);
    expect(velocityToGain(0.5)).toBeCloseTo(0.4, 6);
    expect(velocityToGain(3)).toBeCloseTo(1.0, 6);
    expect(velocityToGain(-1)).toBeCloseTo(0.2, 6);
  });
});
