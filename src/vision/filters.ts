import type { Vec2 } from '@/core/types';

/**
 * One-Euro filter (Casiez et al. 2012): heavy smoothing at rest, light
 * smoothing when moving fast, so rendering is steady without visible lag.
 * Only the render ("smooth") stream uses it; triggers read raw positions.
 */
export class OneEuroFilter {
  private xHat: number | null = null;
  private dxHat = 0;
  private lastT = 0;

  constructor(
    private readonly minCutoff: number,
    private readonly beta: number,
    private readonly dCutoff: number,
  ) {}

  /** @param t timestamp in ms */
  filter(x: number, t: number): number {
    if (this.xHat === null) {
      this.xHat = x;
      this.lastT = t;
      return x;
    }
    const dt = (t - this.lastT) / 1000;
    this.lastT = t;
    if (dt <= 0) return this.xHat;

    const dx = (x - this.xHat) / dt;
    this.dxHat = lowpass(dx, this.dxHat, alpha(this.dCutoff, dt));
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dxHat);
    this.xHat = lowpass(x, this.xHat, alpha(cutoff, dt));
    return this.xHat;
  }

  reset(): void {
    this.xHat = null;
    this.dxHat = 0;
  }
}

function alpha(cutoff: number, dt: number): number {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}

function lowpass(x: number, prev: number, a: number): number {
  return prev + a * (x - prev);
}

export class OneEuro2D {
  private readonly fx: OneEuroFilter;
  private readonly fy: OneEuroFilter;

  constructor(minCutoff: number, beta: number, dCutoff: number) {
    this.fx = new OneEuroFilter(minCutoff, beta, dCutoff);
    this.fy = new OneEuroFilter(minCutoff, beta, dCutoff);
  }

  filter(v: Vec2, t: number): Vec2 {
    return { x: this.fx.filter(v.x, t), y: this.fy.filter(v.y, t) };
  }

  reset(): void {
    this.fx.reset();
    this.fy.reset();
  }
}

export interface VelocityOptions {
  /** Samples closer than this are duplicates and ignored (ms). */
  dtMinMs: number;
  /** Gaps longer than this reset the buffer (ms): no velocity across a tracking loss. */
  dtGapMs: number;
  /** Speeds above this (h/s) are tracker glitches: sample discarded, buffer reset. */
  glitchClamp: number;
  /** Ring size; peak lookups read the last `size` velocities. */
  size?: number;
}

export type VelocityStatus = 'first' | 'ok' | 'skipped' | 'gap' | 'glitch';

export interface VelocitySample {
  t: number;
  p: Vec2;
  /** Backward-difference velocity in h/s; zero for the first sample after a reset. */
  v: Vec2;
}

/**
 * Per-point velocity estimator over real frame timestamps.
 *
 * `vInst` is the one-frame backward difference (the trigger signal: lowest
 * latency). `peakDown(n)` is the largest downward (+y) speed over the last n
 * samples (the intensity signal: hands decelerate into an imaginary surface,
 * so the value at contact under-reads intent).
 */
export class VelocityBuffer {
  private readonly samples: VelocitySample[] = [];
  private readonly size: number;

  constructor(private readonly opts: VelocityOptions) {
    this.size = opts.size ?? 4;
  }

  get last(): VelocitySample | null {
    return this.samples.length ? this.samples[this.samples.length - 1] : null;
  }

  get vInst(): Vec2 {
    return this.last?.v ?? { x: 0, y: 0 };
  }

  /** Time since the previous accepted sample (ms), 0 after a reset. */
  get dt(): number {
    const n = this.samples.length;
    return n >= 2 ? this.samples[n - 1].t - this.samples[n - 2].t : 0;
  }

  push(p: Vec2, t: number): VelocityStatus {
    const last = this.last;
    if (!last) {
      this.samples.push({ t, p, v: { x: 0, y: 0 } });
      return 'first';
    }
    const dt = t - last.t;
    if (dt < this.opts.dtMinMs) return 'skipped';
    if (dt > this.opts.dtGapMs) {
      this.reset();
      this.samples.push({ t, p, v: { x: 0, y: 0 } });
      return 'gap';
    }
    const v = { x: ((p.x - last.p.x) * 1000) / dt, y: ((p.y - last.p.y) * 1000) / dt };
    if (Math.hypot(v.x, v.y) > this.opts.glitchClamp) {
      this.reset();
      return 'glitch';
    }
    this.samples.push({ t, p, v });
    if (this.samples.length > this.size) this.samples.shift();
    return 'ok';
  }

  /** Max downward (+y) speed over the last n samples, h/s. */
  peakDown(n = 3): number {
    let peak = 0;
    for (let i = Math.max(0, this.samples.length - n); i < this.samples.length; i++) {
      peak = Math.max(peak, this.samples[i].v.y);
    }
    return peak;
  }

  reset(): void {
    this.samples.length = 0;
  }
}
