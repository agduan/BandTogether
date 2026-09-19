import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '@/app/config';
import { DEFAULT_ROLE_OPTIONS, distToBand, RoleAssigner, strumScore, type RoleOptions } from '@/detectors/roles';
import { bandGeometry } from '@/detectors/strumDetector';
import { ASPECT, handAt } from './helpers/hands';

const BAND = bandGeometry(DEFAULT_CONFIG.strum, ASPECT);
const IN_BAND = { x: (BAND.x0 + BAND.x1) / 2, y: BAND.y };
const ON_NECK = { x: 0.3 * ASPECT, y: 0.45 };

describe('strum score', () => {
  it('distance to the band is 0 inside it and Euclidean outside', () => {
    expect(distToBand(IN_BAND, BAND)).toBe(0);
    expect(distToBand({ x: IN_BAND.x, y: BAND.y + BAND.halfHeight + 0.1 }, BAND)).toBeCloseTo(0.1, 6);
    expect(distToBand({ x: BAND.x0 - 0.3, y: BAND.y - BAND.halfHeight - 0.4 }, BAND)).toBeCloseTo(0.5, 6);
  });

  it('is 0.4·label + 0.4·proximity + 0.2·side', () => {
    const o = DEFAULT_ROLE_OPTIONS;
    expect(strumScore({ palm: IN_BAND, handedness: 'Right' }, BAND, o)).toBeCloseTo(1, 6);
    expect(strumScore({ palm: IN_BAND, handedness: 'Left' }, BAND, o)).toBeCloseTo(0.6, 6);
    // Far up the neck with the fretting label: nothing but a little proximity.
    expect(strumScore({ palm: ON_NECK, handedness: 'Left' }, BAND, o)).toBeLessThan(0.2);
  });

  it('lefty mirrors the label prior and the strumming side', () => {
    const lefty = { ...DEFAULT_ROLE_OPTIONS, lefty: true };
    const band = bandGeometry({ ...DEFAULT_CONFIG.strum, lefty: true }, ASPECT);
    expect(band.x0).toBeCloseTo((1 - DEFAULT_CONFIG.strum.bandXMax) * ASPECT, 6);
    expect(band.x1).toBeCloseTo((1 - DEFAULT_CONFIG.strum.bandXMin) * ASPECT, 6);
    const inBand = { x: (band.x0 + band.x1) / 2, y: band.y };
    expect(strumScore({ palm: inBand, handedness: 'Left' }, band, lefty)).toBeCloseTo(1, 6);
    expect(strumScore({ palm: inBand, handedness: 'Right' }, band, lefty)).toBeCloseTo(0.6, 6);
  });
});

describe('RoleAssigner', () => {
  const assigner = (over: Partial<RoleOptions> = {}) => new RoleAssigner(() => ({ ...DEFAULT_ROLE_OPTIONS, ...over }));

  it('two hands: the one on the band strums, the other frets, whatever the labels say', () => {
    const roles = assigner().assign([handAt(7, ON_NECK, 0, 0, { handedness: 'Right' }), handAt(8, IN_BAND, 0, 0, { handedness: 'Left' })], BAND, 0);
    expect(roles).toEqual({ strumTrackId: 8, fretTrackId: 7 });
  });

  it('a lone hand near the band strums with no fretting hand; a lone hand up the neck only frets', () => {
    expect(assigner().assign([handAt(1, IN_BAND, 0, 0, { handedness: 'Left' })], BAND, 0)).toEqual({ strumTrackId: 1, fretTrackId: null });
    expect(assigner().assign([handAt(2, ON_NECK, 0, 0, { handedness: 'Left' })], BAND, 0)).toEqual({ strumTrackId: null, fretTrackId: 2 });
  });

  it('is sticky: roles swap only after the new ordering has held for swapMs', () => {
    const a = assigner();
    expect(a.assign([handAt(1, IN_BAND, 0, 0), handAt(2, ON_NECK, 0, 0, { handedness: 'Left' })], BAND, 0).strumTrackId).toBe(1);

    // The hands trade places. Hand 2 now out-scores hand 1, but not for long enough yet.
    const swapped = (t: number) => [handAt(1, ON_NECK, t, 33), handAt(2, IN_BAND, t, 33, { handedness: 'Left' })];
    expect(a.assign(swapped(100), BAND, 100).strumTrackId).toBe(1);
    expect(a.assign(swapped(400), BAND, 400).strumTrackId).toBe(1);
    expect(a.assign(swapped(599), BAND, 599).strumTrackId).toBe(1);
    expect(a.assign(swapped(600), BAND, 600)).toEqual({ strumTrackId: 2, fretTrackId: 1 });
  });

  it('a flicker in the ordering restarts the clock', () => {
    const a = assigner();
    const normal = (t: number) => [handAt(1, IN_BAND, t, 33), handAt(2, ON_NECK, t, 33, { handedness: 'Left' })];
    const swapped = (t: number) => [handAt(1, ON_NECK, t, 33), handAt(2, IN_BAND, t, 33, { handedness: 'Left' })];
    a.assign(normal(0), BAND, 0);
    a.assign(swapped(100), BAND, 100);
    a.assign(normal(400), BAND, 400);
    a.assign(swapped(450), BAND, 450);
    expect(a.assign(swapped(700), BAND, 700).strumTrackId).toBe(1);
    expect(a.assign(swapped(950), BAND, 950).strumTrackId).toBe(2);
  });

  it('claim: a stroking hand takes the role from an idle strummer, not from a busy one', () => {
    const a = assigner();
    const hands = (t: number) => [handAt(1, IN_BAND, t, 33), handAt(2, ON_NECK, t, 33, { handedness: 'Left' })];
    a.assign(hands(0), BAND, 0);
    a.noteStroke(1, 1000);
    expect(a.claim(2, 1300)).toBe(false); // hand 1 strummed 300 ms ago
    expect(a.roles.strumTrackId).toBe(1);
    expect(a.claim(2, 1500)).toBe(true); // idle for swapMs
    expect(a.roles).toEqual({ strumTrackId: 2, fretTrackId: 1 });
    expect(a.claim(2, 1501)).toBe(true); // already the strummer
  });

  it('recent strokes outweigh a flipped handedness label, then fade', () => {
    // Labels flipped: the fret hand carries 'Right' and rests just off the band's neck end.
    const a = assigner();
    const nearBand = { x: BAND.x0 - 0.02, y: BAND.y };
    const hands = (t: number) => [handAt(1, IN_BAND, t, 33, { handedness: 'Left' }), handAt(2, nearBand, t, 33, { handedness: 'Right' })];
    expect(a.assign(hands(0), BAND, 0).strumTrackId).toBe(2); // the label wins on geometry alone
    expect(a.claim(1, 100)).toBe(true); // ...until hand 1 actually strums
    a.noteStroke(1, 100);
    for (let t = 133; t <= 1500; t += 33) expect(a.assign(hands(t), BAND, t).strumTrackId).toBe(1);
    // Long after the last stroke the bonus is gone and the ordering is back to the formula.
    expect(a.assign(hands(9000), BAND, 9000).strumTrackId).toBe(1);
    expect(a.assign(hands(9600), BAND, 9600).strumTrackId).toBe(2);
  });

  it('when the strummer is lost the role is reassigned at once, and reset clears it', () => {
    const a = assigner();
    a.assign([handAt(1, IN_BAND, 0, 0), handAt(2, ON_NECK, 0, 0, { handedness: 'Left' })], BAND, 0);
    // Track 1 drops out and comes back as track 3: no 500 ms wait.
    expect(a.assign([handAt(2, ON_NECK, 33, 33, { handedness: 'Left' })], BAND, 33)).toEqual({ strumTrackId: null, fretTrackId: 2 });
    expect(a.assign([handAt(2, ON_NECK, 66, 33, { handedness: 'Left' }), handAt(3, IN_BAND, 66, 0)], BAND, 66)).toEqual({ strumTrackId: 3, fretTrackId: 2 });
    expect(a.assign([], BAND, 100)).toEqual({ strumTrackId: null, fretTrackId: null });
    a.reset();
    expect(a.roles).toEqual({ strumTrackId: null, fretTrackId: null });
  });
});
