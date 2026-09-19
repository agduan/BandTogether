import type { AudioPlayedEvent } from '@/core/types';

export interface LatencyStats {
  /** Rolling mean of (audio scheduled − vision frame timestamp), ms. */
  pipelineMs: number;
  /** Rolling mean of (audio scheduled − detector emission), ms. */
  audioMs: number;
  /** Reported AudioContext output latency (hardware + buffer), ms. */
  outputMs: number;
  /** Total events measured. */
  count: number;
}

/**
 * Motion-to-sound accounting. Camera capture latency is invisible to JS, so
 * this reports what it can measure: frame timestamp → detector emission →
 * audio scheduling, plus the context's own reported output latency.
 */
export class LatencyMeter {
  readonly stats: LatencyStats = { pipelineMs: 0, audioMs: 0, outputMs: 0, count: 0 };

  constructor(private readonly alpha = 0.2) {}

  record(e: AudioPlayedEvent, outputMs = 0): LatencyStats {
    const pipeline = e.audioT - e.frameT;
    const audio = e.audioT - e.detectT;
    const s = this.stats;
    if (s.count === 0) {
      s.pipelineMs = pipeline;
      s.audioMs = audio;
    } else {
      s.pipelineMs += this.alpha * (pipeline - s.pipelineMs);
      s.audioMs += this.alpha * (audio - s.audioMs);
    }
    s.outputMs = outputMs;
    s.count++;
    return s;
  }

  reset(): void {
    this.stats.pipelineMs = 0;
    this.stats.audioMs = 0;
    this.stats.outputMs = 0;
    this.stats.count = 0;
  }
}

/** Detector velocity (0..1) → linear gain. Keeps soft hits audible. */
export function velocityToGain(velocity: number): number {
  const v = Math.min(1, Math.max(0, velocity));
  return 0.2 + 0.8 * v * v;
}
