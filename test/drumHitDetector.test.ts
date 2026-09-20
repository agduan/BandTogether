import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type Config } from '@/app/config';
import type { HandFrame, Vec2, VisionFrame } from '@/core/types';
import { DrumHitDetector, kitGeometry, kitZones, stickTip } from '@/detectors/drumHitDetector';
import { loadFixture } from './helpers/fixtures';

const ASPECT = 4 / 3;
const DT = 1000 / 30;
const PALM_SIZE = 0.11;

/** The fixed kit (`drum.kit`), which the rules below are written against. */
function config(overrides: Partial<Config['drum']> = {}): Pick<Config, 'drum' | 'filter'> {
  const c = structuredClone(DEFAULT_CONFIG);
  Object.assign(c.drum, { bodyRelative: false }, overrides);
  return c;
}

/** The default: a kit that follows the player. */
const bodyConfig = (overrides: Partial<Config['drum']> = {}) => config({ bodyRelative: true, ...overrides });

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
function sequence(trackId: number, x: number, wristYs: number[], t0 = 1000, playerId = 0): VisionFrame[] {
  let prev: Vec2 | undefined;
  return wristYs.map((y, i) => {
    const h = hand(trackId, { x, y }, t0 + i * DT, i === 0 ? 0 : DT, prev);
    h.playerId = playerId;
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

describe('DrumHitDetector, body-relative kit', () => {
  const LEFT_HALF = { x0: 0, x1: 0.5 };
  const RIGHT_HALF = { x0: 0.5, x1: 1 };
  const inside = (det: DrumHitDetector, region: { x0: number; x1: number }, aspect = ASPECT) => {
    expect(det.geometry).toHaveLength(4);
    for (const p of det.geometry) {
      expect(p.x0).toBeGreaterThanOrEqual(region.x0 * aspect - 1e-9);
      expect(p.x1).toBeLessThanOrEqual(region.x1 * aspect + 1e-9);
    }
  };
  /** Two hands hovering 0.1 either side of `cx` for 400 ms, then the left one plunges (onto the snare). */
  const drummer = (playerId: number, cx: number, trackId = 1): VisionFrame[] => {
    const ys = [...Array<number>(13).fill(0.3), 0.35, 0.4, 0.45, 0.5];
    const l = sequence(trackId, cx - 0.1 - 0.0128, ys, 1000, playerId);
    const r = sequence(trackId + 1, cx + 0.1 - 0.0128, ys.map(() => 0.3), 1000, playerId);
    return l.map((f, i) => ({ ...f, hands: [...f.hands, ...r[i].hands] }));
  };

  it('drums_body_5hits: the kit lands on the resting hands, then five snare hits on the annotations', () => {
    const rec = loadFixture('drums_body_5hits');
    const det = new DrumHitDetector(bodyConfig());
    expect(det.calibration).toBe('auto');
    const hits = rec.frames.flatMap((f) => det.update(f));
    expect(det.calibration).toBe('locked'); // landed once, then stays
    expect(hits.map((h) => h.pad)).toEqual(['snare', 'snare', 'snare', 'snare', 'snare']);
    const expected = rec.annotations!.filter((a) => a.label === 'hit').map((a) => a.t);
    hits.forEach((h, i) => expect(Math.abs(h.t - expected[i])).toBeLessThanOrEqual(DT + 0.01));

    // Anchored between the two sticks, snare line one palm under where they hover; it has not drifted.
    expect(det.anchor!.cx).toBeCloseTo(0.85, 2);
    expect(det.anchor!.cy).toBeCloseTo(0.549 + PALM_SIZE, 2);
    expect(det.anchor!.unit).toBeCloseTo(PALM_SIZE, 3);
    // The fixed kit's snare is nowhere near these hands.
    const fixed = new DrumHitDetector(config());
    expect(rec.frames.flatMap((f) => fixed.update(f))).toHaveLength(0);
  });

  it('drums_body_upstrokes: sinking slowly through the line and whipping up produces no hits', () => {
    const rec = loadFixture('drums_body_upstrokes');
    const det = new DrumHitDetector(bodyConfig());
    expect(rec.frames.flatMap((f) => det.update(f))).toHaveLength(0);
  });

  it('the old fixed-kit fixtures stay silent where they should', () => {
    const det = new DrumHitDetector(bodyConfig());
    expect(loadFixture('drums_upstrokes').frames.flatMap((f) => det.update(f))).toHaveLength(0);
  });

  it('keeps the whole kit inside a half-frame region, and still plays there', () => {
    const right = new DrumHitDetector(bodyConfig(), 0, () => RIGHT_HALF);
    inside(right, RIGHT_HALF); // before anyone is seen
    const hits = drummer(0, 1.0).flatMap((f) => {
      const out = right.update(f);
      inside(right, RIGHT_HALF);
      return out;
    });
    expect(hits.map((h) => h.pad)).toEqual(['snare']);
    expect(right.anchor!.cx).toBeCloseTo(1.0, 3);
    expect(right.anchor!.unit * 8).toBeCloseTo(0.92 * 0.5 * ASPECT, 9); // a 0.88 h kit does not fit a 0.67 h half
    expect(right.padHalfHeight).toBeLessThan(DEFAULT_CONFIG.drum.padHalfHeight); // the art shrinks with it

    // A player hugging the split, and one standing in the wrong half: the kit stops at the line.
    const edge = new DrumHitDetector(bodyConfig(), 0, () => RIGHT_HALF);
    for (const f of drummer(0, 0.72)) edge.update(f);
    inside(edge, RIGHT_HALF);
    expect(Math.min(...edge.geometry.map((p) => p.x0))).toBeCloseTo(ASPECT / 2, 9);

    const rec = loadFixture('drums_body_5hits'); // hands around x 0.85
    const left = new DrumHitDetector(bodyConfig(), 0, () => LEFT_HALF);
    for (const f of rec.frames) {
      left.update(f);
      inside(left, LEFT_HALF, f.aspect);
    }
  });

  it('two drummers keep two kits: each follows, draws and detects their own player', () => {
    const c = bodyConfig();
    const a = new DrumHitDetector(c, 0, () => LEFT_HALF);
    const b = new DrumHitDetector(c, 1, () => RIGHT_HALF);
    const p1 = drummer(1, 1.0, 3);
    const frames = drummer(0, 0.33, 1).map((f, i) => ({ ...f, hands: [...f.hands, ...p1[i].hands] }));
    const hitsA = frames.flatMap((f) => a.update(f));
    const hitsB = frames.flatMap((f) => b.update(f));
    expect(a.anchor!.cx).toBeLessThan(ASPECT / 2);
    expect(b.anchor!.cx).toBeGreaterThan(ASPECT / 2);
    expect(hitsA.map((h) => [h.playerId, h.pad])).toEqual([[0, 'snare']]);
    expect(hitsB.map((h) => [h.playerId, h.pad])).toEqual([[1, 'snare']]);
    // `kit` is what each player's overlay draws from, in drum.kit's shape.
    expect(kitGeometry({ ...c.drum, kit: a.kit }, ASPECT)).toEqual(a.geometry);
    expect(kitGeometry({ ...c.drum, kit: b.kit }, ASPECT)).toEqual(b.geometry);
    expect(a.kit.snare.x1).toBeLessThan(b.kit.snare.x0);
  });

  it('calibrate is a toggle: follow the hands, then pin; reset() keeps it, resetCalibration() forgets it', () => {
    const det = new DrumHitDetector(bodyConfig());
    for (const f of drummer(0, 0.6).slice(0, 13)) det.update(f); // lands on the first rest
    expect(det.calibration).toBe('locked');
    const landed = det.anchor!;
    expect(landed.cx).toBeCloseTo(0.6, 3);

    // Resting somewhere else does nothing until C is pressed...
    const still = (cx: number, t0: number, n: number) => {
      const ys = Array<number>(n).fill(0.35);
      const l = sequence(1, cx - 0.1 - 0.0128, ys, t0);
      const r = sequence(2, cx + 0.1 - 0.0128, ys, t0);
      return l.map((f, i) => ({ ...f, hands: [...f.hands, ...r[i].hands] }));
    };
    for (const f of still(0.8, 2000, 40)) det.update(f);
    expect(det.anchor).toEqual(landed);

    // ...then the kit comes over, and the second press pins it without a jump.
    expect(det.calibrate()).toBe(true);
    expect(det.calibration).toBe('auto');
    for (const f of still(0.8, 4000, 60)) det.update(f);
    const placed = det.anchor!;
    expect(placed.cx).toBeCloseTo(0.8, 2);
    expect(placed.cy).toBeCloseTo(0.35 + 0.249 + PALM_SIZE, 2);
    expect(det.calibrate()).toBe(true);
    expect(det.calibration).toBe('locked');
    expect(det.anchor).toEqual(placed);
    for (const f of still(0.6, 7000, 60)) det.update(f);
    expect(det.anchor).toEqual(placed);

    // A strike on the pinned kit: hand left of the anchor = snare.
    const hits = sequence(1, 0.7, [0.35, 0.35, 0.45, 0.55], 10000).flatMap((f) => det.update(f));
    expect(hits.map((x) => x.pad)).toEqual(['snare']);

    det.reset(); // standby and back: the placement stays
    expect(det.anchor).toEqual(placed);
    det.resetCalibration();
    expect(det.calibration).toBe('auto');
    expect(det.anchor!.cx).toBeCloseTo(ASPECT / 2, 9);

    expect(new DrumHitDetector(config()).calibrate()).toBe(false); // fixed kit
  });

  it('one stroke through two stacked lines is one hit (per-hand refractory)', () => {
    const c = bodyConfig();
    // tom1 stacked right above the snare, same x-range.
    c.drum.layout = { snare: { dx: 0, dy: 0, halfWidth: 1 }, tom1: { dx: 0, dy: -1, halfWidth: 1 } };
    const det = new DrumHitDetector(c);
    // Default anchor: snare line 0.68, tom1 line 0.57. Tip goes 0.449 -> 0.599 -> 0.749 over the centre.
    const x = ASPECT / 2 - 0.0128;
    const hits = sequence(1, x, [0.2, 0.2, 0.35, 0.5]).flatMap((f) => det.update(f));
    expect(hits.map((h) => h.pad)).toEqual(['tom1']);
    c.drum.trackRefractoryMs = 0;
    const det2 = new DrumHitDetector(c);
    expect(sequence(1, x, [0.2, 0.2, 0.35, 0.5]).flatMap((f) => det2.update(f)).map((h) => h.pad)).toEqual(['tom1', 'snare']);
  });

  it('scales the speed gate with the kit: a small far player triggers with a smaller stroke', () => {
    const c = bodyConfig();
    c.drum.anchor.defaultUnit = 0.22; // pretend the thresholds were tuned for a hand twice this big: scale 0.5
    const det = new DrumHitDetector(c);
    // 0.7 h/s: under vMin 1.0, over 0.5.
    const ys = [...Array<number>(13).fill(0.3), 0.3233, 0.3467, 0.37, 0.3933, 0.4167, 0.44, 0.4633];
    expect(sequence(1, 0.6, ys).flatMap((f) => det.update(f)).map((h) => h.pad)).toEqual(['snare']);
    const det1 = new DrumHitDetector(bodyConfig());
    expect(sequence(1, 0.6, ys).flatMap((f) => det1.update(f))).toHaveLength(0);
  });
});
