import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '@/app/config';
import {
  BandScore,
  COMBO_STEP,
  GOOD_POINTS,
  MAX_MULTIPLIER,
  PERFECT_POINTS,
  ScoreKeeper,
  comboMultiplier,
  isScoredEvent,
  judge,
  judgeNow,
  type Judged,
} from '@/audio/score';
import { FREEPLAY_CONTEXT } from '@/audio/modes';
import type { SongContext } from '@/core/types';

const cfg = () => structuredClone(DEFAULT_CONFIG.score);

/** 80 bpm: a beat is 750 ms, an eighth 375 ms, so the configured 60 / 130 ms windows apply unclamped. */
const SLOW = 750;
const PERFECT: Judged = { judgement: 'perfect', offsetMs: 0 };
const GOOD: Judged = { judgement: 'good', offsetMs: 90 };
const MISS: Judged = { judgement: 'miss', offsetMs: 180 };

function songAt(beatPhase: number, bpm = 80): SongContext {
  return { ...FREEPLAY_CONTEXT, bpm, beatPhase };
}

describe('judge', () => {
  it('grades by distance to the nearest grid line, signed early / late', () => {
    expect(judge(1000, 1000, SLOW, 2, 60, 130)).toEqual({ judgement: 'perfect', offsetMs: 0 });
    expect(judge(1040, 1000, SLOW, 2, 60, 130)).toMatchObject({ judgement: 'perfect', offsetMs: 40 });
    expect(judge(900, 1000, SLOW, 2, 60, 130)).toMatchObject({ judgement: 'good', offsetMs: -100 });
    expect(judge(1180, 1000, SLOW, 2, 60, 130)).toMatchObject({ judgement: 'miss', offsetMs: 180 });
  });

  it('counts the subdivision as on-beat, and only that', () => {
    // The "and" of the beat: on the grid for eighths, as far off as possible for quarters.
    expect(judge(1375, 1000, SLOW, 2, 60, 130).judgement).toBe('perfect');
    expect(judge(1375, 1000, SLOW, 1, 60, 130)).toMatchObject({ judgement: 'miss', offsetMs: 375 - 750 });
  });

  it('works many beats away from the reference, before or after it', () => {
    expect(judge(1000 + 7 * SLOW + 20, 1000, SLOW, 2, 60, 130)).toMatchObject({ judgement: 'perfect', offsetMs: 20 });
    const early = judge(1000 - 3 * SLOW - 20, 1000, SLOW, 2, 60, 130);
    expect(early.judgement).toBe('perfect');
    expect(early.offsetMs).toBeCloseTo(-20);
  });

  it('clamps the windows on a fast grid so a miss stays possible', () => {
    // 120 bpm eighths are 250 ms apart: ±130 ms would cover everything.
    expect(judge(125, 0, 500, 2, 60, 130).judgement).toBe('miss');
    expect(judge(100, 0, 500, 2, 60, 130).judgement).toBe('miss');
    expect(judge(85, 0, 500, 2, 60, 130).judgement).toBe('good');
    expect(judge(55, 0, 500, 2, 60, 130).judgement).toBe('good'); // perfect is clamped to 50 ms
    expect(judge(45, 0, 500, 2, 60, 130).judgement).toBe('perfect');
  });

  it('never throws on a degenerate grid', () => {
    expect(judge(10, 0, 0, 2, 60, 130).judgement).toBe('miss');
    expect(judge(10, 0, 500, 0, 60, 130).judgement).toBe('perfect'); // subdivision floors at 1
  });
});

describe('judgeNow', () => {
  it('reads the offset from the song position', () => {
    expect(judgeNow(songAt(0.04), cfg())).toMatchObject({ judgement: 'perfect' });
    expect(judgeNow(songAt(0.04), cfg())!.offsetMs).toBeCloseTo(30);
    expect(judgeNow(songAt(0.96), cfg())!.offsetMs).toBeCloseTo(-30);
    expect(judgeNow(songAt(0.5), cfg())!.judgement).toBe('perfect'); // the "and"
    expect(judgeNow(songAt(0.25), cfg())!.judgement).toBe('miss');
  });

  it('does not judge free play', () => {
    expect(judgeNow(FREEPLAY_CONTEXT, cfg())).toBeNull();
  });

  it('latencyMs shifts every event earlier', () => {
    const c = { ...cfg(), latencyMs: 150 };
    // 150 ms after the beat reads as dead on.
    expect(judgeNow(songAt(0.2), c)!.offsetMs).toBeCloseTo(0);
    expect(judgeNow(songAt(0.2), cfg())!.judgement).toBe('miss');
  });
});

describe('ScoreKeeper', () => {
  it('counts, scores and tracks the combo', () => {
    const k = new ScoreKeeper(cfg());
    k.add(PERFECT);
    k.add(GOOD);
    expect(k.info()).toMatchObject({
      points: PERFECT_POINTS + GOOD_POINTS,
      combo: 2,
      bestCombo: 2,
      perfect: 1,
      good: 1,
      miss: 0,
      last: 'good',
      lastOffsetMs: 90,
      tightness: 0.75, // a good counts half
    });
    k.add(MISS);
    expect(k.info()).toMatchObject({ points: 150, combo: 0, bestCombo: 2, miss: 1, last: 'miss', lastOffsetMs: 180 });
    expect(k.info().tightness).toBeCloseTo(1.5 / 3);
  });

  it('pays a multiplier for a long combo, capped', () => {
    expect(comboMultiplier(0)).toBe(1);
    expect(comboMultiplier(COMBO_STEP - 1)).toBe(1);
    expect(comboMultiplier(COMBO_STEP)).toBe(2);
    expect(comboMultiplier(1000)).toBe(MAX_MULTIPLIER);
    const k = new ScoreKeeper(cfg());
    for (let i = 0; i < COMBO_STEP + 1; i++) k.add(PERFECT);
    expect(k.info().points).toBe(COMBO_STEP * PERFECT_POINTS + 2 * PERFECT_POINTS);
  });

  it('tightness only looks at the last `window` events', () => {
    const k = new ScoreKeeper({ ...cfg(), window: 4 });
    for (let i = 0; i < 4; i++) k.add(MISS);
    expect(k.info().tightness).toBe(0);
    k.add(PERFECT);
    k.add(PERFECT);
    expect(k.info().tightness).toBe(0.5);
    k.add(GOOD);
    k.add(GOOD);
    expect(k.info().tightness).toBe(0.75); // perfect, perfect, good, good
    for (let i = 0; i < 4; i++) k.add(PERFECT);
    expect(k.info().tightness).toBe(1);
  });

  it('random flailing reads clearly looser than steady playing', () => {
    // Offsets spread evenly across the 250 ms gap between eighths at 120 bpm.
    const flail = new ScoreKeeper({ ...cfg(), window: 1000 });
    for (let i = 0; i < 1000; i++) flail.add(judge(i * 0.25, 0, 500, 2, 60, 130));
    expect(flail.info().tightness).toBeGreaterThan(0.5);
    expect(flail.info().tightness).toBeLessThan(0.6);
    // A steady player, ±35 ms around the grid.
    const steady = new ScoreKeeper({ ...cfg(), window: 1000 });
    for (let i = 0; i < 1000; i++) steady.add(judge((i % 71) - 35, 0, 500, 2, 60, 130));
    expect(steady.info().tightness).toBe(1);
  });

  it('info() is a snapshot and reset() starts over', () => {
    const k = new ScoreKeeper(cfg());
    const before = k.info();
    k.add(PERFECT);
    expect(before.points).toBe(0);
    k.reset();
    expect(k.info()).toMatchObject({ points: 0, combo: 0, bestCombo: 0, perfect: 0, last: null, tightness: 0 });
  });
});

describe('BandScore', () => {
  it('keeps players apart and pools them for the band tightness', () => {
    let phase = 0;
    const band = new BandScore(cfg(), () => songAt(phase));
    expect(band.tightness).toBe(0);
    band.hit(0);
    band.hit(0);
    phase = 0.25;
    band.hit(1);
    band.hit(1);
    expect(band.info(0)).toMatchObject({ perfect: 2, miss: 0, tightness: 1 });
    expect(band.info(1)).toMatchObject({ perfect: 0, miss: 2, tightness: 0 });
    expect(band.tightness).toBe(0.5);
    expect(band.info(3).points).toBe(0); // a player who never played
    band.reset();
    expect(band.info(0).points).toBe(0);
    expect(band.tightness).toBe(0);
  });

  it('resetPlayer zeroes one player and their share of the band tightness', () => {
    let phase = 0;
    const band = new BandScore(cfg(), () => songAt(phase));
    band.hit(0);
    phase = 0.25;
    band.hit(1);
    expect(band.tightness).toBe(0.5);
    band.resetPlayer(1);
    expect(band.info(1)).toMatchObject({ points: 0, miss: 0, last: null });
    expect(band.info(0).perfect).toBe(1);
    expect(band.tightness).toBe(1);
    band.resetPlayer(0);
    expect(band.tightness).toBe(0);
  });

  it('changes nothing in free play', () => {
    const band = new BandScore(cfg(), () => FREEPLAY_CONTEXT);
    expect(band.hit(0)).toBeNull();
    expect(band.info(0)).toMatchObject({ points: 0, miss: 0, last: null });
  });
});

describe('isScoredEvent', () => {
  it('scores only the event that sounds on the instrument being played', () => {
    const hit = { type: 'drum.hit', t: 0, playerId: 0, pad: 'snare', velocity: 1 } as const;
    const chord = { type: 'guitar.chord', t: 0, playerId: 0, chord: 'G', confidence: 1 } as const;
    expect(isScoredEvent(hit, 'drums')).toBe(true);
    expect(isScoredEvent(hit, 'guitar')).toBe(false);
    expect(isScoredEvent(chord, 'guitar')).toBe(false);
    expect(isScoredEvent({ type: 'bass.pluck', t: 0, playerId: 0, direction: 'down', velocity: 1, pitchBin: null }, 'bass')).toBe(true);
  });
});
