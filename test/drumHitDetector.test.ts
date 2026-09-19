import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type Config } from '@/app/config';
import type { HandFrame, Vec2, VisionFrame } from '@/core/types';
import { DrumHitDetector, kitGeometry, kitZones, stickTip } from '@/detectors/drumHitDetector';
import { loadFixture } from './helpers/fixtures';

const ASPECT = 4 / 3;
const DT = 1000 / 30;
const PALM_SIZE = 0.11;

function config(overrides: Partial<Config['drum']> = {}): Pick<Config, 'drum' | 'filter'> {
  const c = structuredClone(DEFAULT_CONFIG);
  Object.assign(c.drum, overrides);
  return c;
}

/** A fist with fingers pointing down (drumming pose), wrist at `wrist`. */
function hand(trackId: number, wrist: Vec2, t: number, dt: number, prevPalm?: Vec2): HandFrame {
  const f = (dx: number, dy: number): Vec2 => ({ x: wrist.x + dx * PALM_SIZE, y: wrist.y + dy * PALM_SIZE });
  const raw = [
    f(0, 0),
    f(-0.35, 0.3), f(-0.65, 0.6), f(-0.85, 0.85), f(-1.0, 1.05),
    f(-0.3, 1.0), f(-0.32, 1.45), f(-0.33, 1.75), f(-0.34, 2.0),
    f(0, 1.0), f(0, 1.5), f(0, 1.85), f(0, 2.15),
    f(0.3, 0.95), f(0.32, 1.4), f(0.33, 1.7), f(0.34, 1.95),
    f(0.58, 0.85), f(0.62, 1.2), f(0.64, 1.45), f(0.66, 1.65),
  ];
  const idx = [0, 5, 9, 13, 17];
  const palm = {
    x: idx.reduce((s, i) => s + raw[i].x, 0) / idx.length,
    y: idx.reduce((s, i) => s + raw[i].y, 0) / idx.length,
  };
  const palmVel = prevPalm && dt > 0 ? { x: ((palm.x - prevPalm.x) * 1000) / dt, y: ((palm.y - prevPalm.y) * 1000) / dt } : { x: 0, y: 0 };
  return {
    t, dt, trackId, playerId: 0, handedness: 'Right', handednessScore: 1,
    raw, smooth: raw, world: raw.map((p) => ({ ...p, z: 0 })), palm, palmVel, palmSize: PALM_SIZE,
  };
}

/** Frames for one hand following `wristYs` at a fixed x, 30 fps. */
function sequence(trackId: number, x: number, wristYs: number[], t0 = 1000): VisionFrame[] {
  let prev: Vec2 | undefined;
  return wristYs.map((y, i) => {
    const h = hand(trackId, { x, y }, t0 + i * DT, i === 0 ? 0 : DT, prev);
    prev = h.palm;
    return { t: h.t, aspect: ASPECT, hands: [h], inferenceMs: 10 };
  });
}

describe('stick tip', () => {
  it('extends from the palm along wrist → middle MCP by stickLen · palmSize', () => {
    const h = hand(1, { x: 0.5, y: 0.3 }, 0, 0);
    const tip = stickTip(h.raw, h.palm, h.palmSize, 1.5);
    expect(tip.x).toBeCloseTo(h.palm.x, 6);
    expect(tip.y).toBeCloseTo(h.palm.y + 1.5 * PALM_SIZE, 6);
  });

  it('kit geometry scales x by the aspect and zones straddle the strike line', () => {
    const geo = kitGeometry(DEFAULT_CONFIG.drum, ASPECT);
    const snare = geo.find((p) => p.id === 'snare')!;
    expect(snare.x0).toBeCloseTo(0.31 * ASPECT, 6);
    expect(snare.y).toBe(0.68);
    const zone = kitZones(DEFAULT_CONFIG.drum, ASPECT).find((z) => z.id === 'snare')!;
    expect(zone.y1 - zone.y0).toBeCloseTo(2 * DEFAULT_CONFIG.drum.padHalfHeight, 6);
  });
});

describe('DrumHitDetector on fixtures', () => {
  it('drums_5hits: exactly five snare hits, each within one frame of the annotation', () => {
    const rec = loadFixture('drums_5hits');
    const det = new DrumHitDetector(config());
    const hits = rec.frames.flatMap((f) => det.update(f));
    expect(hits.map((h) => h.pad)).toEqual(['snare', 'snare', 'snare', 'snare', 'snare']);

    const expected = rec.annotations!.filter((a) => a.label === 'hit').map((a) => a.t);
    hits.forEach((h, i) => expect(Math.abs(h.t - expected[i])).toBeLessThanOrEqual(DT + 0.01));
    for (const h of hits) {
      expect(h.velocity).toBeGreaterThan(0.3);
      expect(h.velocity).toBeLessThanOrEqual(1);
      expect(h.playerId).toBe(0);
    }
  });

  it('drums_upstrokes: fast upstrokes and slow returns produce no hits', () => {
    const rec = loadFixture('drums_upstrokes');
    const det = new DrumHitDetector(config());
    expect(rec.frames.flatMap((f) => det.update(f))).toHaveLength(0);
  });

  it('is deterministic across reset', () => {
    const rec = loadFixture('drums_5hits');
    const det = new DrumHitDetector(config());
    const a = rec.frames.flatMap((f) => det.update(f)).map((h) => h.t);
    det.reset();
    const b = rec.frames.flatMap((f) => det.update(f)).map((h) => h.t);
    expect(b).toEqual(a);
  });
});

describe('DrumHitDetector rules', () => {
  const SNARE_X = 0.41 * ASPECT; // wrist x that puts the tip inside the snare's x-range

  it('applies the per-pad refractory across two tracks', () => {
    const det = new DrumHitDetector(config());
    // Both hands strike the snare on the same frame: only one hit.
    const a = sequence(1, SNARE_X, [0.2, 0.2, 0.5]);
    const b = sequence(2, SNARE_X - 0.05, [0.2, 0.2, 0.5]);
    const frames = a.map((f, i) => ({ ...f, hands: [...f.hands, ...b[i].hands] }));
    const hits = frames.flatMap((f) => det.update(f));
    expect(hits).toHaveLength(1);
  });

  it('lets two tracks hit the same pad once the pad refractory has passed', () => {
    const det = new DrumHitDetector(config());
    const a = sequence(1, SNARE_X, [0.2, 0.2, 0.5, 0.5, 0.5, 0.5]);
    const b = sequence(2, SNARE_X - 0.05, [0.2, 0.2, 0.2, 0.2, 0.2, 0.5]);
    const frames = a.map((f, i) => ({ ...f, hands: [...f.hands, ...b[i].hands] }));
    const hits = frames.flatMap((f) => det.update(f));
    expect(hits.map((h) => h.pad)).toEqual(['snare', 'snare']);
  });

  it('resolves a crossing that meets two overlapping pads to the nearer centre', () => {
    // Give hi-hat and snare the same strike line and overlapping x-ranges.
    const c = config();
    c.drum.kit.hihat = { x0: 0.2, x1: 0.45, y: 0.68 };
    c.drum.kit.snare = { x0: 0.4, x1: 0.6, y: 0.68 };
    const det = new DrumHitDetector(c);
    // Tip x ≈ 0.43 · aspect: inside both, closer to the snare centre (0.5) than the hi-hat centre (0.325).
    const hits = sequence(1, 0.43 * ASPECT - 0.0128, [0.2, 0.2, 0.5]).flatMap((f) => det.update(f));
    expect(hits.map((h) => h.pad)).toEqual(['snare']);
  });

  it('ignores hands of another player and re-derives state after a track gap', () => {
    const det = new DrumHitDetector(config(), 0);
    const frames = sequence(1, SNARE_X, [0.2, 0.2, 0.5]);
    frames.forEach((f) => f.hands.forEach((h) => (h.playerId = 1)));
    expect(frames.flatMap((f) => det.update(f))).toHaveLength(0);

    // Same track, now player 0, reappearing below the line with dt = 0: no phantom hit.
    const below = hand(1, { x: SNARE_X, y: 0.5 }, 5000, 0);
    expect(det.update({ t: 5000, aspect: ASPECT, hands: [below], inferenceMs: 10 })).toHaveLength(0);
  });

  it('reads thresholds live: raising vMin above the stroke speed silences it', () => {
    const c = config();
    const det = new DrumHitDetector(c);
    const frames = sequence(1, SNARE_X, [0.2, 0.2, 0.5, 0.2, 0.2, 0.2, 0.2, 0.2, 0.5]);
    const first = det.update(frames[0]).concat(det.update(frames[1]), det.update(frames[2]));
    expect(first).toHaveLength(1);
    c.drum.vMin = 20;
    const rest = frames.slice(3).flatMap((f) => det.update(f));
    expect(rest).toHaveLength(0);
  });

  it('tracks the palm instead of the stick tip when configured', () => {
    const det = new DrumHitDetector(config({ trackedPoint: 'palm' }));
    // Palm sits ~0.084 h below the wrist: wrist 0.45 → 0.75 carries the palm through the snare line.
    const hits = sequence(1, SNARE_X, [0.45, 0.45, 0.75]).flatMap((f) => det.update(f));
    expect(hits.map((h) => h.pad)).toEqual(['snare']);
  });
});
