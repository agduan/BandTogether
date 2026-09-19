import { describe, expect, it } from 'vitest';
import { OneEuroFilter, VelocityBuffer } from '@/vision/filters';

const opts = { dtMinMs: 8, dtGapMs: 120, glitchClamp: 12 };

describe('VelocityBuffer', () => {
  it('computes h/s velocity over irregular real frame intervals', () => {
    const vb = new VelocityBuffer(opts);
    expect(vb.push({ x: 0, y: 0 }, 1000)).toBe('first');
    expect(vb.vInst).toEqual({ x: 0, y: 0 });

    expect(vb.push({ x: 0, y: 0.033 }, 1033)).toBe('ok'); // 33 ms
    expect(vb.vInst.y).toBeCloseTo(1.0, 6);

    expect(vb.push({ x: 0.132, y: 0.033 }, 1099)).toBe('ok'); // 66 ms, x moved 0.132
    expect(vb.vInst.x).toBeCloseTo(2.0, 6);
    expect(vb.vInst.y).toBeCloseTo(0, 6);
    expect(vb.dt).toBe(66);
  });

  it('ignores duplicate frames closer than dtMinMs', () => {
    const vb = new VelocityBuffer(opts);
    vb.push({ x: 0, y: 0 }, 1000);
    vb.push({ x: 0, y: 0.1 }, 1033);
    expect(vb.push({ x: 0, y: 0.9 }, 1036)).toBe('skipped');
    expect(vb.vInst.y).toBeCloseTo(0.1 / 0.033, 3);
  });

  it('treats long gaps as a track loss: no velocity across the gap', () => {
    const vb = new VelocityBuffer(opts);
    vb.push({ x: 0, y: 0 }, 1000);
    vb.push({ x: 0, y: 0.05 }, 1033);
    expect(vb.push({ x: 0.5, y: 0.5 }, 1300)).toBe('gap');
    expect(vb.vInst).toEqual({ x: 0, y: 0 });
    expect(vb.dt).toBe(0);
  });

  it('discards impossible jumps and resets (identity-swap glitch)', () => {
    const vb = new VelocityBuffer(opts);
    vb.push({ x: 0, y: 0 }, 1000);
    vb.push({ x: 0, y: 0.05 }, 1033);
    expect(vb.push({ x: 1.0, y: 0.05 }, 1066)).toBe('glitch'); // 30 h/s
    expect(vb.last).toBeNull();
    expect(vb.push({ x: 1.0, y: 0.05 }, 1099)).toBe('first');
  });

  it('peakDown reports the largest downward speed of recent samples', () => {
    const vb = new VelocityBuffer({ ...opts, size: 4 });
    let y = 0;
    vb.push({ x: 0, y }, 0);
    for (const step of [0.02, 0.1, 0.06, -0.05]) {
      y += step;
      vb.push({ x: 0, y }, vb.last!.t + 33);
    }
    // Speeds over 33 ms steps: 0.61, 3.03, 1.82, -1.52 h/s; last three peak at 0.1/0.033.
    expect(vb.peakDown(3)).toBeCloseTo(0.1 / 0.033, 3);
    expect(vb.peakDown(1)).toBe(0); // upward motion never counts as a hit
  });
});

describe('OneEuroFilter', () => {
  it('returns the first sample unchanged and converges on a constant', () => {
    const f = new OneEuroFilter(1.0, 3.0, 1.0);
    expect(f.filter(0.5, 0)).toBe(0.5);
    let out = 0.5;
    for (let i = 1; i <= 60; i++) out = f.filter(0.8, i * 33);
    expect(out).toBeCloseTo(0.8, 2);
  });

  it('smooths jitter at rest but follows fast motion closely (adaptive cutoff)', () => {
    const rest = new OneEuroFilter(1.0, 3.0, 1.0);
    let maxDeviation = 0;
    for (let i = 0; i <= 90; i++) {
      const jitter = i % 2 === 0 ? 0.004 : -0.004; // ±2 px at 480p
      const out = rest.filter(0.5 + jitter, i * 33);
      if (i > 10) maxDeviation = Math.max(maxDeviation, Math.abs(out - 0.5));
    }
    expect(maxDeviation).toBeLessThan(0.002); // jitter halved or better

    const moving = new OneEuroFilter(1.0, 3.0, 1.0);
    let lag = 0;
    for (let i = 0; i <= 30; i++) {
      const x = i * 0.066; // 2 h/s ramp
      const out = moving.filter(x, i * 33);
      if (i > 10) lag = Math.max(lag, x - out);
    }
    expect(lag).toBeLessThan(0.05); // under ~25 ms of lag at 2 h/s
  });
});
