import { describe, expect, it } from 'vitest';
import type { ToneAudioNode } from 'tone';
import { InstrumentController } from '@/app/controller';
import { DEFAULT_CONFIG } from '@/app/config';
import { createInstrument } from '@/app/instruments';
import { EasyMode, FREEPLAY_CONTEXT, FreeplayChords, HardMode, strumChord } from '@/audio/modes';
import { GuitarVoice, planStrum } from '@/audio/voices/guitarVoice';
import { bus } from '@/core/bus';
import type { SongContext, StringSound, StrumEvent, VisionFrame } from '@/core/types';
import { FREEPLAY_LOOP, parseChord, VOICINGS, voicingFor } from '@/song/chords';
import { SONGS } from '@/song/songs';
import { flattenBars } from '@/song/types';
import { ASPECT, handAt } from './helpers/hands';

const strum = (direction: 'down' | 'up', over: Partial<StrumEvent> = {}): StrumEvent => ({
  type: 'guitar.strum', t: 1000, playerId: 0, direction, velocity: 0.8, chord: null, chordConfidence: 0, ...over,
});
const onChart = (chord: string): SongContext => ({ ...FREEPLAY_CONTEXT, bpm: 120, chord });
const SPREAD = { spreadMinMs: 4, spreadMaxMs: 20, humanizeMs: 0 };

describe('chord voicings', () => {
  it('every chord in every built-in chart has a hand-written voicing', () => {
    for (const song of Object.values(SONGS)) {
      for (const bar of flattenBars(song)) expect(VOICINGS[bar.chord], `${song.title}: ${bar.chord}`).toBeDefined();
    }
    for (const chord of FREEPLAY_LOOP) expect(VOICINGS[chord]).toBeDefined();
  });

  it('voicings have six slots, low to high', () => {
    for (const v of Object.values(VOICINGS)) expect(v).toHaveLength(6);
    expect(VOICINGS.D.slice(0, 2)).toEqual([null, null]);
    expect(VOICINGS.Em[0]).toBe('E2');
  });

  it('an unlisted chord still sounds: nearest open shape, else a built triad', () => {
    expect(voicingFor('Em7')).toBe(VOICINGS.Em);
    expect(voicingFor('G/B')).toBe(VOICINGS.G);
    expect(voicingFor('F')).toEqual([null, 'F2', 'C3', 'F3', 'A3', 'C4']);
    expect(voicingFor('Bm')).toEqual([null, 'B2', 'F#3', 'B3', 'D4', 'F#4']);
    expect(voicingFor('Bb')).toEqual([null, 'A#2', 'F3', 'A#3', 'D4', 'F4']);
    expect(voicingFor('N.C.')).toBeNull();
  });

  it('parseChord reads root and quality, ignoring extensions', () => {
    expect(parseChord('F#m7')).toEqual({ root: 6, minor: true });
    expect(parseChord('Cmaj7')).toEqual({ root: 0, minor: false });
    expect(parseChord('Db')).toEqual({ root: 1, minor: false });
    expect(parseChord('?')).toBeNull();
  });
});

describe('strum resolution', () => {
  it('a down-strum plays every string of the chart chord and leans on the bass string', () => {
    const r = new EasyMode().resolveStrum(strum('down'), onChart('C'));
    expect(r.notes).toEqual([null, 'C3', 'E3', 'G3', 'C4', 'E4']);
    expect(r.chord).toBe('C');
    expect(r.direction).toBe('down');
    expect(r.velocities[1]).toBeCloseTo(0.8);
    expect(r.velocities[5]).toBeCloseTo(0.8 * 0.85);
  });

  it('an up-strum reaches the top four strings, softer, unless the hand is at the neck end', () => {
    const up = strumChord(strum('up', { u: 0.7 }), 'G');
    expect(up.notes).toEqual([null, null, 'D3', 'G3', 'B3', 'G4']);
    expect(up.velocities[5]).toBeCloseTo(0.8 * 0.85);
    expect(strumChord(strum('up'), 'G').notes.slice(0, 2)).toEqual([null, null]); // injected strums carry no u
    expect(strumChord(strum('up', { u: 0.1 }), 'G').notes).toEqual([...VOICINGS.G]);
  });

  it('hard mode plays the chart chord too, so the guitar never goes silent', () => {
    expect(new HardMode().resolveStrum(strum('down'), onChart('Em')).notes).toEqual([...VOICINGS.Em]);
  });

  it('an unparseable chart chord is silent rather than wrong', () => {
    expect(new EasyMode().resolveStrum(strum('down'), onChart('N.C.')).notes).toEqual([]);
  });

  it('free play walks G D Em C, four strums a chord, and starts over after a pause', () => {
    const loop = new FreeplayChords();
    const heard = Array.from({ length: 18 }, (_, i) => loop.next(1000 + i * 300));
    expect(heard.slice(0, 5)).toEqual(['G', 'G', 'G', 'G', 'D']);
    expect(heard[8]).toBe('Em');
    expect(heard[12]).toBe('C');
    expect(heard[16]).toBe('G');
    expect(loop.next(1000 + 17 * 300 + 300)).toBe('G');
    const mid = new FreeplayChords();
    for (let i = 0; i < 5; i++) mid.next(i * 300);
    expect(mid.next(1500)).toBe('D');
    expect(mid.next(1500 + 4001)).toBe('G');

    const easy = new EasyMode();
    expect(easy.resolveStrum(strum('down'), FREEPLAY_CONTEXT).chord).toBe('G');
  });
});

describe('planStrum', () => {
  const none = [null, null, null, null, null, null];
  const G = strumChord(strum('down', { velocity: 1 }), 'G');

  it('staggers a down-strum low to high and an up-strum high to low, first string on time', () => {
    const down = planStrum(none, null, G, SPREAD);
    expect(down.attacks.map((a) => a.string)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(down.attacks[0].at).toBe(0);
    expect(down.attacks[5].at).toBeCloseTo(5 * 0.004);
    expect(down.releases).toEqual([]);

    const up = planStrum(none, null, strumChord(strum('up', { velocity: 1 }), 'G'), SPREAD);
    expect(up.attacks.map((a) => a.string)).toEqual([5, 4, 3, 2]);
    expect(up.attacks[0].at).toBe(0);
  });

  it('a lazy stroke spreads wider than a fast one, and humanize never schedules into the past', () => {
    const soft: StringSound = { ...G, velocities: G.velocities.map(() => 0) };
    expect(planStrum(none, null, soft, SPREAD).attacks[5].at).toBeCloseTo(5 * 0.02);
    const early = planStrum(none, null, G, { ...SPREAD, humanizeMs: 50 }, () => 0);
    expect(Math.min(...early.attacks.map((a) => a.at))).toBe(0);
  });

  it('re-strumming a chord damps each string as it is struck and leaves the others ringing', () => {
    const ringing = [...VOICINGS.G];
    const up = planStrum(ringing, 'G', strumChord(strum('up'), 'G'), SPREAD);
    expect(up.releases.map((r) => r.string)).toEqual([5, 4, 3, 2]);
    expect(up.releases.map((r) => r.at)).toEqual(up.attacks.map((a) => a.at));
  });

  it('a chord change damps the strings the new chord does not strike, at once', () => {
    const plan = planStrum([...VOICINGS.G], 'G', strumChord(strum('down'), 'D'), SPREAD);
    expect(plan.releases.filter((r) => r.at === 0 && r.string < 2).map((r) => r.note)).toEqual(['G2', 'B2']);
    expect(plan.attacks.map((a) => a.note)).toEqual(['D3', 'A3', 'D4', 'F#4']);
  });
});

describe('guitar instrument', () => {
  const deps = () => ({ config: structuredClone(DEFAULT_CONFIG), output: () => ({}) as ToneAudioNode });
  const frameWith = (...hands: ReturnType<typeof handAt>[]): VisionFrame => ({ t: 1000, aspect: ASPECT, hands, inferenceMs: 0 });

  it('has a real voice, and a strum reaches it with the chart chord resolved', () => {
    const guitar = createInstrument('guitar', deps());
    expect(guitar.voice).toBeInstanceOf(GuitarVoice);
    const sounds: Partial<StringSound>[] = [];
    guitar.voice.trigger = (s) => void sounds.push(s);
    const controller = new InstrumentController({
      playerId: 0, instrument: guitar, resolver: new EasyMode(), audio: { stamp: () => {} }, song: () => onChart('D'),
    });
    bus.emit(strum('down'));
    expect(sounds).toHaveLength(1);
    expect(sounds[0]).toMatchObject({ chord: 'D', direction: 'down', notes: [...VOICINGS.D] });
    controller.dispose();
  });

  it('an unloaded voice drops strums instead of throwing', () => {
    const voice = new GuitarVoice(() => ({}) as ToneAudioNode, () => DEFAULT_CONFIG.guitar, '/samples/guitar-acoustic/');
    expect(() => voice.trigger(strumChord(strum('down'), 'G'))).not.toThrow();
    expect(voice.chord).toBeNull();
    expect(() => voice.releaseAll()).not.toThrow();
  });

  it('calibrate centres the band on the strumming hand and reset puts it back', () => {
    const d = deps();
    const guitar = createInstrument('guitar', d);
    const before = { ...d.config.strum };
    expect(guitar.calibrate?.(frameWith())).toBe(false);

    // Two hands, no roles yet: the screen-right one is the strummer for a right-handed player.
    const fret = handAt(1, { x: 0.3, y: 0.4 }, 1000, 0);
    const strummer = handAt(2, { x: 0.5 * ASPECT, y: 0.7 }, 1000, 0);
    expect(guitar.calibrate?.(frameWith(fret, strummer))).toBe(true);
    const { strum: s } = d.config;
    expect((s.bandXMin + s.bandXMax) / 2).toBeCloseTo(0.5);
    expect(s.bandXMax - s.bandXMin).toBeCloseTo(before.bandXMax - before.bandXMin);
    expect(s.bandY).toBeCloseTo(0.7);
    const view = guitar.view?.();
    expect(view?.instrument === 'guitar' && view.band.y).toBeCloseTo(0.7);

    // A hand at the very edge keeps the whole band on screen.
    guitar.calibrate?.(frameWith(handAt(2, { x: ASPECT, y: 0.99 }, 1000, 0)));
    expect(s.bandXMax).toBeCloseTo(1);
    expect(s.bandY).toBeCloseTo(1 - s.bandHalfHeight);

    // The reset survives an instrument swap (a new guitar on the same config).
    guitar.dispose?.();
    const again = createInstrument('guitar', d);
    again.resetCalibration?.();
    expect(d.config.strum).toEqual(before);
  });

  it('centres on the whole hand, not the palm, and is never narrower than the hand', () => {
    const d = deps();
    const guitar = createInstrument('guitar', d);
    // Strumming pose close to the camera: wrist at the palm, fingers reaching 0.4 h toward the neck (screen-left).
    const hand = handAt(1, { x: 0.9, y: 0.6 }, 1000, 0);
    hand.raw = hand.raw.map((p, i) => (i >= 5 ? { x: 0.9 - 0.1 * Math.ceil((i - 4) / 4) * 0.8, y: p.y } : { x: 0.9 + 0.02, y: p.y }));
    const xs = hand.raw.map((p) => p.x);
    const [left, right] = [Math.min(...xs), Math.max(...xs)];
    expect(guitar.calibrate?.(frameWith(hand))).toBe(true);
    const view = guitar.view?.();
    if (view?.instrument !== 'guitar') throw new Error('no guitar view');
    expect((view.band.x0 + view.band.x1) / 2).toBeCloseTo((left + right) / 2);
    expect(view.band.x0).toBeLessThan(left);
    expect(view.band.x1).toBeGreaterThan(hand.palm.x);
    expect(view.band.y).toBeCloseTo(0.6); // the centreline stays on the palm, the point that crosses it

    // A small, far hand keeps the default width; calibrating again does not ratchet the width up.
    guitar.calibrate?.(frameWith(handAt(1, { x: 0.7, y: 0.5 }, 1000, 0)));
    expect(d.config.strum.bandXMax - d.config.strum.bandXMin).toBeCloseTo(DEFAULT_CONFIG.strum.bandXMax - DEFAULT_CONFIG.strum.bandXMin);
  });

  it('lefty placement mirrors: the band lands under a screen-left hand', () => {
    const d = deps();
    d.config.strum.lefty = true;
    const guitar = createInstrument('guitar', d);
    guitar.calibrate?.(frameWith(handAt(1, { x: 0.3 * ASPECT, y: 0.6 }, 1000, 0), handAt(2, { x: 0.8 * ASPECT, y: 0.4 }, 1000, 0)));
    const view = guitar.view?.();
    if (view?.instrument !== 'guitar') throw new Error('no guitar view');
    expect((view.band.x0 + view.band.x1) / 2 / ASPECT).toBeCloseTo(0.3);
    expect(view.band.y).toBeCloseTo(0.6);
  });
});
