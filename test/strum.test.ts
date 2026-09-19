import { describe, expect, it } from 'vitest';
import type { ToneAudioNode } from 'tone';
import { DEFAULT_CONFIG, type Config } from '@/app/config';
import { InstrumentController } from '@/app/controller';
import { createInstrument } from '@/app/instruments';
import { createResolver } from '@/audio/modes';
import { bus } from '@/core/bus';
import type { StrumEvent } from '@/core/types';
import { bandGeometry, GuitarStrumDetector, StrumDetector } from '@/detectors/strumDetector';
import { loadFixture } from './helpers/fixtures';
import { ASPECT, DT, mergeFrames, palmSequence } from './helpers/hands';

function config(overrides: Partial<Config['strum']> = {}): Pick<Config, 'strum' | 'filter'> {
  const c = structuredClone(DEFAULT_CONFIG);
  Object.assign(c.strum, overrides);
  return c;
}

const BAND = bandGeometry(DEFAULT_CONFIG.strum, ASPECT);
const BAND_X = (BAND.x0 + BAND.x1) / 2;
/** One full stroke down through the centreline (0.62) and one back up, ~2 h/s. */
const DOWN_UP = [0.5, 0.5, 0.57, 0.64, 0.71, 0.74, 0.74, 0.67, 0.6, 0.53, 0.5];

describe('band geometry', () => {
  it('scales the config fractions by the aspect', () => {
    expect(BAND).toEqual({ x0: 0.53 * ASPECT, x1: 0.81 * ASPECT, y: 0.62, halfHeight: 0.05 });
  });

  it('is laid out inside the player region (row 16 hands each player a half)', () => {
    const left = bandGeometry(DEFAULT_CONFIG.strum, ASPECT, { x0: 0, x1: 0.5 });
    expect(left.x0).toBeCloseTo(0.265 * ASPECT, 6);
    expect(left.x1).toBeCloseTo(0.405 * ASPECT, 6);
    const right = bandGeometry(DEFAULT_CONFIG.strum, ASPECT, { x0: 0.5, x1: 1 });
    expect(right.x0).toBeCloseTo(0.765 * ASPECT, 6);
  });
});

describe('GuitarStrumDetector on fixtures', () => {
  it('strum_alternating: ≥90% of annotated strums detected with the right direction, no extras', () => {
    const rec = loadFixture('strum_alternating');
    const det = new GuitarStrumDetector(config());
    const strums = rec.frames.flatMap((f) => det.update(f));
    const expected = rec.annotations!.filter((a) => a.label === 'strum');
    expect(expected).toHaveLength(26);

    // The Schmitt trigger fires once the palm clears the hysteresis band: up to ~2 frames after the centreline.
    const used = new Set<number>();
    const correct = expected.filter((a) => {
      const i = strums.findIndex((s, k) => !used.has(k) && s.t >= a.t - DT && s.t - a.t <= 2.5 * DT && s.direction === a.detail);
      if (i >= 0) used.add(i);
      return i >= 0;
    });
    expect(correct.length / expected.length).toBeGreaterThanOrEqual(0.9);
    expect(strums.length).toBeLessThanOrEqual(expected.length);

    // Strict alternation, and the big strokes read louder than the sloppy ones.
    strums.forEach((s, i) => i > 0 && expect(s.direction).not.toBe(strums[i - 1].direction));
    const big = strums.filter((s) => s.t < 5500);
    const small = strums.filter((s) => s.t > 5500);
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(mean(big.map((s) => s.velocity))).toBeGreaterThan(mean(small.map((s) => s.velocity)) + 0.1);
    for (const s of strums) {
      expect(s).toMatchObject({ type: 'guitar.strum', playerId: 0, chord: null, chordConfidence: 0 });
      expect(s.velocity).toBeGreaterThanOrEqual(DEFAULT_CONFIG.strum.floor);
      expect(s.velocity).toBeLessThanOrEqual(1);
      expect(s.u).toBeGreaterThan(0.3);
      expect(s.u).toBeLessThan(0.7);
    }

    // Roles: the right hand on the band strums, the left hand up the neck frets.
    expect(det.roles).toEqual({ strumTrackId: 1, fretTrackId: 2 });
  });

  it('strum_alternating with flipped handedness labels and the fret hand beside the band: still ≥90%', () => {
    // MediaPipe's Left/Right comes out flipped on some laptops; the label is a prior, not a gate.
    const rec = loadFixture('strum_alternating');
    for (const f of rec.frames) {
      for (const h of f.hands) {
        h.handedness = h.handedness === 'Left' ? 'Right' : 'Left';
        if (h.trackId === 2) h.palm = { x: h.palm.x + 0.3, y: h.palm.y + 0.15 };
      }
    }
    const det = new GuitarStrumDetector(config());
    expect(det.update(rec.frames[0])).toHaveLength(0);
    expect(det.roles.strumTrackId).toBe(2); // wrong at first: the idle fret hand carries the strumming label
    const strums = rec.frames.slice(1).flatMap((f) => det.update(f));
    expect(strums.length).toBeGreaterThanOrEqual(24);
    strums.forEach((s, i) => i > 0 && expect(s.direction).not.toBe(strums[i - 1].direction));
    expect(det.roles).toEqual({ strumTrackId: 1, fretTrackId: 2 });
  });

  it('is deterministic across reset', () => {
    const rec = loadFixture('strum_alternating');
    const det = new GuitarStrumDetector(config());
    const a = rec.frames.flatMap((f) => det.update(f)).map((s) => `${s.t}${s.direction}`);
    det.reset();
    const b = rec.frames.flatMap((f) => det.update(f)).map((s) => `${s.t}${s.direction}`);
    expect(b).toEqual(a);
  });

  it('the drum fixtures never strum (the hands stay far from the band)', () => {
    const det = new GuitarStrumDetector(config());
    expect(loadFixture('drums_upstrokes').frames.flatMap((f) => det.update(f))).toHaveLength(0);
  });
});

describe('strum rules', () => {
  it('a stroke down and back up is one down-strum then one up-strum', () => {
    const det = new GuitarStrumDetector(config());
    const strums = palmSequence(1, BAND_X, DOWN_UP).flatMap((f) => det.update(f));
    expect(strums.map((s) => s.direction)).toEqual(['down', 'up']);
    expect(strums[0].u).toBeCloseTo(0.5, 2);
  });

  it('jitter inside the hysteresis band fires nothing, and a slow drift through it fires nothing', () => {
    const det = new GuitarStrumDetector(config());
    const jitter = [0.61, 0.63, 0.61, 0.635, 0.605, 0.63, 0.61];
    expect(palmSequence(1, BAND_X, jitter).flatMap((f) => det.update(f))).toHaveLength(0);
    det.reset();
    const drift = Array.from({ length: 30 }, (_, i) => 0.5 + i * 0.01); // 0.3 h/s < vMin
    expect(palmSequence(1, BAND_X, drift).flatMap((f) => det.update(f))).toHaveLength(0);
  });

  it('a small stroke that is already slowing at the hysteresis edge still fires (peak speed gate)', () => {
    const det = new GuitarStrumDetector(config());
    // 0.9 h/s through the centreline, then 0.3 h/s across the +hyst edge.
    const strums = palmSequence(1, BAND_X, [0.57, 0.57, 0.6, 0.63, 0.641]).flatMap((f) => det.update(f));
    expect(strums.map((s) => s.direction)).toEqual(['down']);
  });

  it('strokes outside the band x-range (± tolerance) are ignored', () => {
    const det = new GuitarStrumDetector(config({ strummerOnly: false }));
    expect(palmSequence(1, BAND.x0 - 0.1, DOWN_UP).flatMap((f) => det.update(f))).toHaveLength(0);
    expect(palmSequence(2, BAND.x0 - 0.03, DOWN_UP, 5000).flatMap((f) => det.update(f))).toHaveLength(2);
  });

  it('only the strummer fires while it is busy; strummerOnly=false lets either hand strum', () => {
    const c = config();
    const det = new StrumDetector(() => c.strum, c.filter);
    // Right hand strums down at t = 1100 and stays; the left hand then sweeps down and up through the
    // band's neck end 200 ms and 367 ms later, inside roleSwapMs, so it cannot take the role.
    const left = palmSequence(2, BAND.x0 + 0.02, [0.5, 0.5, 0.5, 0.5, 0.5, ...DOWN_UP], 1000, { handedness: 'Left' });
    const right = palmSequence(1, BAND.x1 - 0.05, [0.5, 0.5, 0.57, ...left.slice(3).map(() => 0.66)]);
    expect(mergeFrames(right, left).flatMap((f) => det.update(f)).map((s) => s.trackId)).toEqual([1]);
    expect(det.roles).toEqual({ strumTrackId: 1, fretTrackId: 2 });

    c.strum.strummerOnly = false;
    det.reset();
    expect(mergeFrames(right, left).flatMap((f) => det.update(f)).map((s) => s.trackId)).toEqual([1, 2, 2]);
  });

  it('a stroke from the other hand takes the role once the strummer has been idle for roleSwapMs', () => {
    const c = config();
    const det = new StrumDetector(() => c.strum, c.filter);
    const idle = Array.from({ length: 20 }, () => 0.5); // 667 ms of nothing after the right hand's strum
    const left = palmSequence(2, BAND.x0 + 0.02, [0.5, 0.5, 0.5, ...idle, ...DOWN_UP], 1000, { handedness: 'Left' });
    const right = palmSequence(1, BAND.x1 - 0.05, [0.5, 0.5, 0.57, ...left.slice(3).map(() => 0.66)]);
    expect(mergeFrames(right, left).flatMap((f) => det.update(f)).map((s) => s.trackId)).toEqual([1, 2, 2]);
    expect(det.roles).toEqual({ strumTrackId: 2, fretTrackId: 1 });
  });

  it('refractory is per band: two hands crossing together make one strum', () => {
    const det = new GuitarStrumDetector(config({ strummerOnly: false }));
    const a = palmSequence(1, BAND_X, [0.5, 0.5, 0.57, 0.64, 0.71]);
    const b = palmSequence(2, BAND_X + 0.1, [0.5, 0.5, 0.57, 0.64, 0.71]);
    expect(mergeFrames(a, b).flatMap((f) => det.update(f))).toHaveLength(1);
  });

  it('ignores another player and does not fire when a track reappears across the line', () => {
    const det = new GuitarStrumDetector(config(), 0);
    expect(palmSequence(1, BAND_X, DOWN_UP, 1000, { playerId: 1 }).flatMap((f) => det.update(f))).toHaveLength(0);
    const above = palmSequence(1, BAND_X, [0.5, 0.5]);
    const below = palmSequence(1, BAND_X, [0.75, 0.75], 5000); // dt = 0 on the first frame: a gap
    expect([...above, ...below].flatMap((f) => det.update(f))).toHaveLength(0);
  });

  it('reads thresholds live', () => {
    const c = config();
    const det = new GuitarStrumDetector(c);
    expect(palmSequence(1, BAND_X, DOWN_UP).flatMap((f) => det.update(f))).toHaveLength(2);
    c.strum.vMin = 20;
    expect(palmSequence(1, BAND_X, DOWN_UP, 5000).flatMap((f) => det.update(f))).toHaveLength(0);
  });

  it('lefty mirrors the band and keeps u = 0 at the neck end', () => {
    const det = new GuitarStrumDetector(config({ lefty: true }));
    const band = bandGeometry({ ...DEFAULT_CONFIG.strum, lefty: true }, ASPECT);
    // Near the screen-right end of the mirrored band = the neck end for a lefty.
    const strums = palmSequence(1, band.x1 - 0.02, DOWN_UP, 1000, { handedness: 'Left' }).flatMap((f) => det.update(f));
    expect(strums).toHaveLength(2);
    expect(strums[0].u).toBeLessThan(0.1);
    expect(det.band.x0).toBeCloseTo(band.x0, 6);
  });

  it('velocity-onset fallback: small strokes inside the band that never reach the centreline still strum', () => {
    const ys = [0.56, 0.56, 0.585, 0.61, 0.612, 0.612, 0.587, 0.562, 0.56, 0.56]; // 0.75 h/s, stays above 0.62
    const crossing = new GuitarStrumDetector(config());
    expect(palmSequence(1, BAND_X, ys).flatMap((f) => crossing.update(f))).toHaveLength(0);
    const onset = new GuitarStrumDetector(config({ useVelocityOnset: true }));
    expect(palmSequence(1, BAND_X, ys).flatMap((f) => onset.update(f)).map((s) => s.direction)).toEqual(['down', 'up']);
  });
});

describe('StrumDetector (shared core)', () => {
  it('runs on the bass band options unchanged, so K5 only has to wrap it', () => {
    const c = structuredClone(DEFAULT_CONFIG);
    const det = new StrumDetector(() => c.bass, c.filter, 0);
    const strokes = palmSequence(1, BAND_X, DOWN_UP).flatMap((f) => det.update(f));
    expect(strokes.map((s) => s.direction)).toEqual(['down', 'up']);
    expect(strokes[0].trackId).toBe(1);
  });
});

describe('guitar instrument end to end', () => {
  it('fixture frames through the controller reach the bus as strums, and the view publishes the roles', () => {
    const guitar = createInstrument('guitar', { config: structuredClone(DEFAULT_CONFIG), output: () => ({}) as ToneAudioNode });
    const controller = new InstrumentController({ playerId: 0, instrument: guitar, resolver: createResolver('easy'), audio: { stamp: () => {} } });
    const heard: StrumEvent[] = [];
    const off = bus.on('guitar.strum', (e) => heard.push(e));
    for (const f of loadFixture('strum_alternating').frames) controller.onFrame(f);
    off();
    controller.dispose();

    expect(heard).toHaveLength(26);
    expect(heard[0]).toMatchObject({ direction: 'down', playerId: 0 });
    expect(guitar.view?.()).toMatchObject({ instrument: 'guitar', strumTrackId: 1, fretTrackId: 2 });
  });
});
