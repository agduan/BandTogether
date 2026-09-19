import { describe, expect, it } from 'vitest';
import { CrossingDetector, type CrossingEvent, type CrossingOptions } from '@/detectors/crossingCore';
import { speedToIntensity } from '@/detectors/detector';
import type { Vec2 } from '@/core/types';

const DRUM: CrossingOptions = {
  lineY: 0.6,
  x0: 0.4,
  x1: 0.7,
  xTolerance: 0.03,
  direction: 'down',
  vMin: 1.0,
  dirCos: 0.6,
  rearmMargin: 0.04,
  refractoryMs: 80,
  refractoryOppositeMs: 0,
  anticipateMs: 0,
};

const STRUM: CrossingOptions = {
  ...DRUM,
  direction: 'both',
  vMin: 0.5,
  dirCos: 0,
  rearmMargin: 0.02,
  refractoryMs: 60,
  refractoryOppositeMs: 40,
};

/** Feed a path of points at a fixed frame interval; velocity is the backward difference. */
function run(det: CrossingDetector, path: Vec2[], dtMs = 33, t0 = 1000): CrossingEvent[] {
  const events: CrossingEvent[] = [];
  let prev: Vec2 | null = null;
  path.forEach((p, i) => {
    const t = t0 + i * dtMs;
    const v = prev ? { x: ((p.x - prev.x) * 1000) / dtMs, y: ((p.y - prev.y) * 1000) / dtMs } : { x: 0, y: 0 };
    const e = det.update(p, v, prev ? dtMs : 0, t);
    if (e) events.push(e);
    prev = p;
  });
  return events;
}

const at = (x: number, ...ys: number[]): Vec2[] => ys.map((y) => ({ x, y }));

describe('CrossingDetector (down mode: drums)', () => {
  it('fires exactly once for a fast hit that jumps over the line in one frame', () => {
    const det = new CrossingDetector(DRUM);
    // 0.45 -> 0.75 in one frame = 9 h/s, far past the pad's thin line.
    const events = run(det, at(0.55, 0.45, 0.45, 0.75, 0.78, 0.7));
    expect(events).toHaveLength(1);
    expect(events[0].direction).toBe('down');
    expect(events[0].speed).toBeCloseTo(0.3 / 0.033, 1);
    expect(events[0].xAtCross).toBeCloseTo(0.55, 6);
  });

  it('interpolates the crossing x for a diagonal segment and rejects it when outside the pad', () => {
    const inside = new CrossingDetector(DRUM);
    // From (0.40, 0.50) to (0.50, 0.70): crosses y=0.6 at x=0.45 (inside 0.4..0.7), cone 0.89.
    const hit = run(inside, [{ x: 0.4, y: 0.5 }, { x: 0.4, y: 0.5 }, { x: 0.5, y: 0.7 }]);
    expect(hit).toHaveLength(1);
    expect(hit[0].xAtCross).toBeCloseTo(0.45, 6);

    const outside = new CrossingDetector(DRUM);
    // From (0.10, 0.50) to (0.20, 0.70): crosses at x=0.15 (outside).
    const events = run(outside, [{ x: 0.1, y: 0.5 }, { x: 0.1, y: 0.5 }, { x: 0.2, y: 0.7 }]);
    expect(events).toHaveLength(0);
    expect(outside.currentSide).toBe('below'); // side still updates, so no phantom later
  });

  it('fires once for a hit followed by jitter around the line, then again after re-arming', () => {
    const det = new CrossingDetector(DRUM);
    const path = [
      ...at(0.55, 0.4, 0.4, 0.5, 0.62), // hit: 0.5 -> 0.62 = 3.6 h/s
      ...at(0.55, 0.61, 0.59, 0.605, 0.595, 0.61, 0.59), // jitter ±0.01 around the line
      ...at(0.55, 0.57, 0.55, 0.5), // rises past lineY - 0.04 = 0.56: re-armed
      ...at(0.55, 0.5, 0.5, 0.5, 0.5, 0.5), // wait out any refractory
      ...at(0.55, 0.55, 0.66), // second hit
    ];
    const events = run(det, path);
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.direction)).toEqual(['down', 'down']);
  });

  it('never fires on an upstroke, and the upstroke re-arms', () => {
    const det = new CrossingDetector(DRUM);
    const events = run(det, at(0.55, 0.7, 0.7, 0.4, 0.4, 0.4, 0.7));
    expect(events).toHaveLength(1);
    expect(events[0].direction).toBe('down');
    expect(events[0].t).toBe(1000 + 5 * 33);
  });

  it('ignores slow crossings below vMin', () => {
    const det = new CrossingDetector(DRUM);
    // 0.59 -> 0.61 over a frame = 0.6 h/s < 1.0
    expect(run(det, at(0.55, 0.55, 0.57, 0.59, 0.61, 0.63))).toHaveLength(0);
  });

  it('rejects lateral sweeps that dip through the line (direction cone)', () => {
    const det = new CrossingDetector(DRUM);
    // Crosses the line moving mostly sideways: vx = 12 h/s, vy = 1.2 h/s -> cos 0.1.
    const events = run(det, [
      { x: 0.1, y: 0.58 },
      { x: 0.1, y: 0.58 },
      { x: 0.5, y: 0.62 },
    ]);
    expect(events).toHaveLength(0);
  });

  it('enforces the refractory even when re-armed in time', () => {
    const det = new CrossingDetector({ ...DRUM, rearmMargin: 0.01 });
    // Two full hits 66 ms apart (< 80 ms refractory): only the first counts.
    const events = run(det, at(0.55, 0.5, 0.5, 0.7, 0.5, 0.7, 0.5), 33);
    expect(events).toHaveLength(1);
  });

  it('re-derives the side after a tracking gap without firing', () => {
    const det = new CrossingDetector(DRUM);
    det.update({ x: 0.55, y: 0.4 }, { x: 0, y: 0 }, 0, 1000);
    // Reappears below the line 300 ms later with dt = 0 (gap): no phantom hit.
    expect(det.update({ x: 0.55, y: 0.75 }, { x: 0, y: 0 }, 0, 1300)).toBeNull();
    expect(det.currentSide).toBe('below');
  });

  it('anticipation fires one frame early and does not double-fire on the real crossing', () => {
    const det = new CrossingDetector({ ...DRUM, anticipateMs: 40 });
    // Approaching at 3 h/s: at y=0.5 the predicted y is 0.62 -> fires before the actual cross.
    const events = run(det, at(0.55, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8));
    expect(events).toHaveLength(1);
    expect(events[0].anticipated).toBe(true);
    expect(events[0].t).toBe(1000 + 2 * 33);
  });
});

describe('CrossingDetector (both mode: strums)', () => {
  it('alternates down/up events as the hand oscillates through the band', () => {
    const det = new CrossingDetector(STRUM);
    // Oscillate ±0.06 around the line, two frames per half-cycle (66 ms between
    // opposite strums, 132 ms between same-direction ones): 1.8 h/s, past the 0.02 hysteresis.
    const events = run(det, at(0.55, 0.54, 0.54, 0.6, 0.66, 0.6, 0.54, 0.6, 0.66, 0.6, 0.54, 0.6, 0.66), 33);
    expect(events.map((e) => e.direction)).toEqual(['down', 'up', 'down', 'up', 'down']);
    expect(events.every((e) => e.speed > STRUM.vMin)).toBe(true);
  });

  it('ignores tremor inside the hysteresis band', () => {
    const det = new CrossingDetector(STRUM);
    expect(run(det, at(0.55, 0.59, 0.59, 0.61, 0.59, 0.61, 0.59), 33)).toHaveLength(0);
  });

  it('applies the opposite-direction refractory', () => {
    const det = new CrossingDetector({ ...STRUM, refractoryOppositeMs: 100 });
    // down at frame 2, up at frame 3 (33 ms later): the up is suppressed.
    const events = run(det, at(0.55, 0.54, 0.54, 0.66, 0.54, 0.54, 0.54, 0.54, 0.66), 33);
    expect(events.map((e) => e.direction)).toEqual(['down', 'down']);
  });
});

describe('speedToIntensity', () => {
  it('maps speed into [floor, 1] with a perceptual curve', () => {
    expect(speedToIntensity(0.5, 1, 4)).toBe(0.3);
    expect(speedToIntensity(4, 1, 4)).toBeCloseTo(1, 6);
    expect(speedToIntensity(9, 1, 4)).toBeCloseTo(1, 6);
    const mid = speedToIntensity(2.5, 1, 4);
    expect(mid).toBeGreaterThan(0.3 + 0.7 * 0.5); // curve is concave: mid speed > linear midpoint
    expect(speedToIntensity(1, 0.5, 3, 0.35)).toBeCloseTo(0.35 + 0.65 * Math.pow(0.2, 0.7), 6);
  });
});
