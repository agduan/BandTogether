import { describe, expect, it } from 'vitest';
import type { ToneAudioNode } from 'tone';
import { InstrumentController } from '@/app/controller';
import { DEFAULT_CONFIG } from '@/app/config';
import { createInstrument, type InstrumentDeps } from '@/app/instruments';
import { BASS_LOWEST } from '@/audio/backing';
import { bassNote, createResolver, EasyMode, FREEPLAY_CONTEXT, HardMode } from '@/audio/modes';
import { BassVoice, planBassNote } from '@/audio/voices/bassVoice';
import { bus } from '@/core/bus';
import type { BassStrumEvent, Instrument, SongContext, Vec2, VisionFrame } from '@/core/types';
import type { BandGeometry } from '@/core/views';
import { BassStrumDetector } from '@/detectors/bassDetector';
import { BassOverlay } from '@/detectors/bassOverlay';
import { midiToNote, noteToMidi } from '@/song/chords';
import { SONGS } from '@/song/songs';
import { flattenBars } from '@/song/types';
import { loadFixture } from './helpers/fixtures';
import { ASPECT, handAt, palmSequence } from './helpers/hands';

const stroke = (direction: 'down' | 'up', over: Partial<BassStrumEvent> = {}): BassStrumEvent => ({
  type: 'bass.strum', t: 1000, playerId: 0, direction, velocity: 0.8, ...over,
});
const onChart = (chord: string): SongContext => ({ ...FREEPLAY_CONTEXT, bpm: 120, chord });
const deps = (over: Partial<InstrumentDeps> = {}): InstrumentDeps => ({ config: structuredClone(DEFAULT_CONFIG), output: () => ({}) as ToneAudioNode, ...over });
const frameWith = (...hands: VisionFrame['hands']): VisionFrame => ({ t: 1000, aspect: ASPECT, hands, inferenceMs: 0 });
const bandOf = (bass: Instrument): BandGeometry => (bass.view?.() as { band: BandGeometry }).band;

describe('bass note resolution', () => {
  it('a stroke plays the root of the chart chord, in the register the backing bass uses, down and up alike', () => {
    for (const mode of [new EasyMode(), new HardMode()]) {
      expect(mode.resolveBass(stroke('down'), onChart('G'))).toEqual({ notes: ['G2'], velocities: [0.8], direction: 'down', chord: 'G' });
      expect(mode.resolveBass(stroke('up', { velocity: 0.5 }), onChart('G'))).toMatchObject({ notes: ['G2'], velocities: [0.5] });
      expect(mode.resolveBass(stroke('down'), onChart('Em')).notes).toEqual(['E2']);
      expect(mode.resolveBass(stroke('down'), onChart('C')).notes).toEqual(['C3']);
      expect(mode.resolveBass(stroke('down'), onChart('D')).notes).toEqual(['D3']);
    }
  });

  it('every chord in every built-in chart gives a note inside E2..D#3; a name nobody can parse is silent', () => {
    for (const song of Object.values(SONGS)) {
      for (const bar of flattenBars(song)) {
        const midi = noteToMidi(bassNote(stroke('down'), bar.chord).notes[0] as string);
        expect(midi, `${song.title}: ${bar.chord}`).toBeGreaterThanOrEqual(BASS_LOWEST);
        expect(midi).toBeLessThan(BASS_LOWEST + 12);
      }
    }
    expect(bassNote(stroke('down'), 'N.C.').notes).toEqual([]);
  });

  it('free play walks the G D Em C loop, four strokes a chord, like the guitar', () => {
    const mode = createResolver('easy');
    const notes = Array.from({ length: 17 }, (_, i) => mode.resolveBass(stroke(i % 2 ? 'up' : 'down', { t: 1000 + i * 300 }), FREEPLAY_CONTEXT).notes[0]);
    expect(notes).toEqual([...Array(4).fill('G2'), ...Array(4).fill('D3'), ...Array(4).fill('E2'), ...Array(4).fill('C3'), 'G2']);
  });
});

describe('bass voice', () => {
  it('noteToMidi is the inverse of midiToNote', () => {
    for (let m = 24; m < 90; m++) expect(noteToMidi(midiToNote(m))).toBe(m);
    expect(noteToMidi('Bb2')).toBe(46);
    expect(noteToMidi('H2')).toBeNull();
    expect(noteToMidi('G')).toBeNull();
  });

  it('plays the guitar sample an octave above the note at about half speed', () => {
    expect(planBassNote('G2')).toEqual({ note: 'G2', sample: 'G3', playbackRate: 0.5 });
    expect(planBassNote('E2')).toEqual({ note: 'E2', sample: 'E3', playbackRate: 0.5 });
    // Between two loaded files: the nearer one, at most a semitone and a half away from the octave.
    const c3 = planBassNote('C3')!;
    expect(c3.sample).toBe('C#4');
    expect(c3.playbackRate).toBeCloseTo(2 ** (-13 / 12));
    for (let m = BASS_LOWEST; m < BASS_LOWEST + 12; m++) {
      const rate = planBassNote(midiToNote(m))!.playbackRate;
      expect(rate).toBeGreaterThan(0.45);
      expect(rate).toBeLessThan(0.56);
    }
  });

  it('`bass.octave` shifts the whole instrument and still finds a file an octave up', () => {
    expect(planBassNote('G2', -1)).toEqual({ note: 'G1', sample: 'G2', playbackRate: 0.5 });
    expect(planBassNote('E2', -1)).toEqual({ note: 'E1', sample: 'E2', playbackRate: 0.5 });
    expect(planBassNote('?', 0)).toBeNull();
  });

  it('drops notes until its samples are loaded, and never throws', () => {
    const voice = new BassVoice(() => ({}) as ToneAudioNode, () => DEFAULT_CONFIG.bass);
    expect(() => voice.trigger(bassNote(stroke('down'), 'G'))).not.toThrow();
    expect(voice.note).toBeNull();
    expect(() => voice.releaseAll()).not.toThrow();
    expect(() => voice.dispose()).not.toThrow();
  });
});

describe('BassStrumDetector', () => {
  it('strum_alternating: the same strokes as the guitar, one event each', () => {
    const rec = loadFixture('strum_alternating');
    const det = new BassStrumDetector(structuredClone(DEFAULT_CONFIG));
    const strokes = rec.frames.flatMap((f) => det.update(f));
    expect(strokes).toHaveLength(26);
    strokes.forEach((p, i) => i > 0 && expect(p.direction).not.toBe(strokes[i - 1].direction));
    for (const p of strokes) expect(p).toMatchObject({ type: 'bass.strum', playerId: 0 });
    expect(det.roles).toEqual({ strumTrackId: 1, fretTrackId: 2 });

    det.reset();
    expect(rec.frames.flatMap((f) => det.update(f))).toHaveLength(26);
  });

  it('the drum fixtures never play the bass', () => {
    const det = new BassStrumDetector(structuredClone(DEFAULT_CONFIG));
    expect(loadFixture('drums_upstrokes').frames.flatMap((f) => det.update(f))).toHaveLength(0);
  });

  it('reads handedness from the `strum` keys, live', () => {
    const config = structuredClone(DEFAULT_CONFIG);
    const det = new BassStrumDetector(config);
    const right = det.band;
    config.strum.lefty = true;
    expect(det.band.x0 / ASPECT).toBeCloseTo(1 - right.x1 / ASPECT);
    expect(det.band.x1 / ASPECT).toBeCloseTo(1 - right.x0 / ASPECT);
  });
});

describe('bass instrument end to end', () => {
  it('fixture frames through the controller reach the bus as bass events; the view has no active bin', () => {
    const bass = createInstrument('bass', deps());
    const controller = new InstrumentController({ playerId: 0, instrument: bass, resolver: createResolver('easy'), audio: { stamp: () => {} } });
    const heard: BassStrumEvent[] = [];
    const off = bus.on('bass.strum', (e) => heard.push(e));
    for (const f of loadFixture('strum_alternating').frames) controller.onFrame(f);
    off();
    controller.dispose();
    expect(heard).toHaveLength(26);
    expect(bass.view?.()).toMatchObject({ instrument: 'bass', note: null });
  });

  it('calibrate centres the band on the strumming hand and reset puts it back', () => {
    const d = deps();
    const bass = createInstrument('bass', d);
    const before = structuredClone(d.config.bass);
    const home = bandOf(bass);
    expect(bass.calibrate?.(frameWith())).toBe(false);

    expect(bass.calibrate?.(frameWith(handAt(1, { x: 0.3, y: 0.4 }, 1000, 0), handAt(2, { x: 0.5 * ASPECT, y: 0.7 }, 1000, 0)))).toBe(true);
    const band = bandOf(bass);
    expect((band.x0 + band.x1) / 2 / ASPECT).toBeCloseTo(0.5);
    expect((band.x1 - band.x0) / ASPECT).toBeCloseTo(before.bandXMax - before.bandXMin);
    expect(band.y).toBeCloseTo(0.7);

    // A placed band is where strokes are detected.
    const ys = [0.6, 0.6, 0.64, 0.7, 0.76, 0.8, 0.8];
    const det = bass.detectors[0];
    expect(palmSequence(2, 0.5 * ASPECT, ys, 2000).flatMap((f) => det.update(f))).toHaveLength(1);

    // The placement is this bass's own: the shared config is never written, and a reset goes back to it.
    expect(d.config.bass).toEqual(before);
    bass.resetCalibration?.();
    expect(bandOf(bass)).toEqual(home);
    d.config.bass.bandY = 0.4;
    expect(bandOf(bass).y).toBeCloseTo(0.4);
  });

  it('two bassists are two basses, each inside its own half', () => {
    const config = structuredClone(DEFAULT_CONFIG);
    const p0 = createInstrument('bass', deps({ config, playerId: 0, region: () => ({ x0: 0, x1: 0.5 }) }));
    const p1 = createInstrument('bass', deps({ config, playerId: 1, region: () => ({ x0: 0.5, x1: 1 }) }));
    const mid = ASPECT / 2;
    expect(bandOf(p0).x1).toBeLessThanOrEqual(mid);
    expect(bandOf(p1).x0).toBeGreaterThanOrEqual(mid);

    const frame = frameWith(handAt(1, { x: 0.3, y: 0.5 }, 1000, 0, { playerId: 0 }), handAt(2, { x: mid + 0.2, y: 0.8 }, 1000, 0, { playerId: 1 }));
    const home0 = bandOf(p0);
    expect(p1.calibrate?.(frame)).toBe(true);
    expect(bandOf(p0)).toEqual(home0);
    expect((bandOf(p1).x0 + bandOf(p1).x1) / 2).toBeCloseTo(mid + 0.2);
    expect(bandOf(p1).y).toBeCloseTo(0.8);
    // A player cannot calibrate off the other player's hand.
    expect(p0.calibrate?.(frameWith(handAt(2, { x: mid + 0.2, y: 0.8 }, 1000, 0, { playerId: 1 })))).toBe(false);
  });
});

/** A canvas that records the polyline drawn with the widest stroke (the string) and every text. */
function fakeCtx() {
  const texts: string[] = [];
  const paths: { width: number; ys: number[] }[] = [];
  let ys: number[] = [];
  const target: Record<string, unknown> = {
    beginPath: () => void (ys = []),
    moveTo: (_x: number, y: number) => ys.push(y),
    lineTo: (_x: number, y: number) => ys.push(y),
    stroke: () => paths.push({ width: target.lineWidth as number, ys }),
    fillText: (text: string) => texts.push(text),
  };
  const ctx = new Proxy(target, { get: (t, p) => t[p as string] ?? (() => {}), set: (t, p, v) => ((t[p as string] = v), true) });
  const string = () => paths.filter((p) => p.ys.length > 20).at(-1)!;
  return { ctx: ctx as unknown as CanvasRenderingContext2D, texts, string };
}

describe('bass overlay', () => {
  const toPx = (v: Vec2): Vec2 => ({ x: v.x * 480, y: v.y * 480 });
  const at = (t: number): VisionFrame => ({ t, aspect: ASPECT, hands: [], inferenceMs: 0 });
  const swing = (ys: number[]) => Math.max(...ys) - Math.min(...ys);

  it('with no bass art registered the bass draws its own string: idle it is straight and says where to strum', () => {
    const bass = createInstrument('bass', deps({ song: () => onChart('Em') }));
    expect(bass.overlay).toBeInstanceOf(BassOverlay);
    const { ctx, texts, string } = fakeCtx();
    bass.overlay.draw(ctx, at(1000), toPx);
    expect(swing(string().ys)).toBe(0);
    expect(string().ys[0]).toBeCloseTo(DEFAULT_CONFIG.bass.bandY * 480);
    expect(texts).toEqual(['STRUM HERE', 'E']); // the pill shows the root a stroke plays, not the chord
    bass.dispose?.();
  });

  it('a stroke of this player makes the string swing and glow, harder strokes swing further, and it dies away', () => {
    const bass = createInstrument('bass', deps({ playerId: 1 }));
    const overlay = bass.overlay as BassOverlay;
    bus.emit(stroke('down', { t: 1000, playerId: 0 })); // somebody else's
    expect(overlay.glowAt(1010)).toBe(0);

    const swingAfter = (velocity: number) => {
      bus.emit(stroke('down', { t: 1000, playerId: 1, velocity }));
      const { ctx, texts, string } = fakeCtx();
      overlay.draw(ctx, at(1010), toPx);
      expect(texts).not.toContain('STRUM HERE'); // the arrow takes its place while the stroke shows
      return swing(string().ys);
    };
    const soft = swingAfter(0.4);
    const hard = swingAfter(1);
    expect(soft).toBeGreaterThan(0.5);
    expect(hard).toBeGreaterThan(soft * 1.5);
    expect(overlay.glowAt(1010)).toBeGreaterThan(0.9);
    expect(overlay.glowAt(1220)).toBeCloseTo(0.5);

    const late = fakeCtx();
    overlay.draw(late.ctx, at(1600), toPx);
    expect(swing(late.string().ys)).toBe(0);
    expect(late.texts).toContain('STRUM HERE');
    expect(overlay.glowAt(990)).toBe(1); // an injected stroke is stamped slightly ahead of the frame being drawn
    expect(overlay.glowAt(100)).toBe(0); // a looping replay's clock runs backwards

    // Swapped out: it stops listening.
    bass.dispose?.();
    bus.emit(stroke('up', { t: 3000, playerId: 1 }));
    expect(overlay.glowAt(3010)).toBe(0);
  });

  it('follows the band the player placed', () => {
    const bass = createInstrument('bass', deps());
    bass.calibrate?.(frameWith(handAt(1, { x: 0.5 * ASPECT, y: 0.75 }, 1000, 0)));
    const { ctx, string } = fakeCtx();
    bass.overlay.draw(ctx, at(1000), toPx);
    expect(string().ys[0]).toBeCloseTo(0.75 * 480);
  });
});
