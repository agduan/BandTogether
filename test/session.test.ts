import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '@/app/config';
import { getSong } from '@/song/songs';
import { Session } from '@/app/session';
import { bus } from '@/core/bus';
import { FREEPLAY_CONTEXT } from '@/audio/modes';
import type { AppEvent, InstrumentId, SongContext } from '@/core/types';
import { GuitarFx } from '@/render/fx';

/** A Session never touches the camera, model or audio context until `start()`, so fakes are enough. */
function makeSession(instrument: InstrumentId | null = 'drums'): Session {
  const video = {} as HTMLVideoElement;
  const canvas = { getContext: () => ({}) } as unknown as HTMLCanvasElement;
  const s = new Session(video, canvas, structuredClone(DEFAULT_CONFIG));
  s.setInstrument(instrument); // what the UI does for a player who picked one
  return s;
}

const seen: AppEvent[] = [];
let off = bus.onAny((e) => seen.push(e));
afterEach(() => {
  off();
  seen.length = 0;
  off = bus.onAny((e) => seen.push(e));
});

describe('Session seams', () => {
  it('a new session has no instrument: nothing to play, draw or score, and the full band may back it', () => {
    const s = makeSession(null);
    expect(s.controllers).toHaveLength(0);
    expect(s.info().instrument).toBeNull();
    expect(s.info().players).toHaveLength(1);
    expect(s.info().players[0]).toMatchObject({ id: 0, instrument: null, hands: 0, calibration: 'none' });
    s.kick(); // no drummer: nothing is emitted
    expect(seen.filter((e) => e.type === 'drum.hit')).toHaveLength(0);
    expect(s.calibrate()).toBe(false);
    s.setMode('hard');
    s.setStandby(true);
    s.setStandby(false);
    s.stop();
  });

  it('setInstrument(null) takes the instrument away and gives it back on request', () => {
    const s = makeSession();
    const drums = s.controllers[0];
    let triggers = 0;
    drums.instrument.voice.trigger = () => void triggers++;
    s.setInstrument(null);
    expect(s.controllers).toHaveLength(0);
    expect(s.info().players[0].instrument).toBeNull();
    bus.emit({ type: 'drum.hit', t: 1, playerId: 0, pad: 'snare', velocity: 0.8 });
    expect(triggers).toBe(0);
    s.setInstrument('guitar');
    expect(s.info().instrument).toBe('guitar');
    s.setInstrument('drums', 1); // players past the first wait for row 16
    expect(s.info().players).toHaveLength(1);
    s.stop();
  });

  it('a player setup that names no instrument for a player clears it (the UI says nothing for "None")', async () => {
    const s = makeSession();
    // Done with drums still picked: the same controller stays, score and calibration with it.
    const drums = s.controllers[0];
    s.setNumPlayers(1);
    s.setInstrument('drums', 0);
    await Promise.resolve();
    expect(s.controllers[0]).toBe(drums);
    // Done with "None": only setNumPlayers is called.
    s.setNumPlayers(1);
    expect(s.info().instrument).toBe('drums'); // nothing happens inside the tick
    await Promise.resolve();
    expect(s.info().instrument).toBeNull();
    // An explicit null (ask 13) is the same thing, at once.
    s.setInstrument('guitar');
    s.setNumPlayers(1);
    s.setInstrument(null, 0);
    expect(s.info().instrument).toBeNull();
    await Promise.resolve();
    s.setInstrument('bass');
    await Promise.resolve();
    expect(s.info().instrument).toBe('bass'); // no sweep left over
    s.stop();
  });

  it('reports the drums through info() once the UI picks them', () => {
    const s = makeSession();
    const info = s.info();
    expect(info.instrument).toBe('drums');
    expect(info.players).toHaveLength(1);
    expect(info.players[0]).toMatchObject({ id: 0, instrument: 'drums', hands: 0, calibration: 'locked' }); // the default kit stays put until C
    expect(info.players[0].score.points).toBe(0);
    // HudInfo fields stay at the top level.
    expect(info).toMatchObject({ mode: 'easy', songTitle: null, songRunning: false, beatsPerBar: 4, paused: false });
    expect(info.song).toMatchObject({ id: 'viva-la-vida', bpm: 138, barCount: 8, running: false, lyric: null });
    expect(info.backing.enabled).toBe(true);
    expect(info.singer).toMatchObject({ enabled: false, level: 0, error: null });
    s.stop();
  });

  it('setInstrument swaps the controller and uses registered guitar art', () => {
    const s = makeSession();
    const drums = s.controllers[0];
    s.setInstrument('guitar');
    const guitar = s.controllers[0];
    expect(guitar).not.toBe(drums);
    expect(guitar.instrument.id).toBe('guitar');
    expect(guitar.instrument.overlay).toBeInstanceOf(GuitarFx);
    expect(guitar.instrument.view?.()).toMatchObject({ instrument: 'guitar', chord: null });
    expect(s.info().instrument).toBe('guitar');

    s.setInstrument('bass');
    expect(s.info().players[0].instrument).toBe('bass');
    expect(s.controllers[0].instrument.view?.()).toMatchObject({ instrument: 'bass', activeBin: null });

    expect(() => s.setInstrument('keyboard')).toThrow();
    expect(s.info().instrument).toBe('bass'); // a failed swap leaves the old instrument in place
    s.stop();
  });

  it('the swapped-out controller stops listening to the bus', () => {
    const s = makeSession();
    const drums = s.controllers[0];
    let triggers = 0;
    drums.instrument.voice.trigger = () => void triggers++;
    s.kick();
    expect(triggers).toBe(1);
    s.setInstrument('guitar');
    s.kick(); // no drummer: nothing is emitted
    bus.emit({ type: 'drum.hit', t: 1, playerId: 0, pad: 'snare', velocity: 0.8 });
    expect(triggers).toBe(1);
    expect(seen.filter((e) => e.type === 'drum.hit')).toHaveLength(2);
    s.stop();
  });

  it('calibrate always answers with a toast', () => {
    const s = makeSession();
    expect(s.calibrate()).toBe(false);
    const toasts = seen.filter((e) => e.type === 'ui.toast');
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({ kind: 'warn' });

    // The drum kit is placed with two presses: the first starts following the hands, the second pins it.
    s.lastFrame = { t: 1, aspect: 4 / 3, hands: [], inferenceMs: 0 };
    expect(s.calibrate()).toBe(true);
    expect(s.info().players[0].calibration).toBe('auto');
    expect(s.calibrate()).toBe(true);
    const texts = seen.filter((e) => e.type === 'ui.toast').slice(1);
    expect(texts[0]).toMatchObject({ kind: 'success' });
    expect(texts[1]).toMatchObject({ text: 'Kit locked', kind: 'success' });

    // Any other instrument that can calibrate gets the latest frame and a plain answer.
    s.setInstrument('guitar');
    s.controllers[0].instrument.calibrate = () => true;
    expect(s.calibrate()).toBe(true);
    expect(seen.filter((e) => e.type === 'ui.toast')[3]).toMatchObject({ text: 'Calibrated', kind: 'success' });
    s.stop();
  });

  it('standby holds the band: no sound, no kick, no score, and instruments picked meanwhile stay quiet until it ends', () => {
    const s = makeSession();
    let triggers = 0;
    s.controllers[0].instrument.voice.trigger = () => void triggers++;
    s.kick();
    expect(triggers).toBe(1);

    s.setStandby(true);
    expect(s.info().standby).toBe(true);
    s.kick();
    bus.emit({ type: 'drum.hit', t: 1, playerId: 0, pad: 'snare', velocity: 0.8 });
    expect(triggers).toBe(1);

    s.setInstrument('guitar'); // what Edit players does before Done
    expect(s.controllers[0].muted).toBe(true);
    let strums = 0;
    s.controllers[0].instrument.voice.trigger = () => void strums++;
    bus.emit({ type: 'guitar.strum', t: 2, playerId: 0, direction: 'down', velocity: 0.8, chord: null, chordConfidence: 0 });
    expect(strums).toBe(0);

    s.setStandby(false);
    expect(s.info().standby).toBe(false);
    bus.emit({ type: 'guitar.strum', t: 3, playerId: 0, direction: 'down', velocity: 0.8, chord: null, chordConfidence: 0 });
    expect(strums).toBe(1);
    s.stop();
  });

  it('setMode reaches every controller; setBacking and setNumPlayers record the choice', () => {
    const s = makeSession();
    s.setMode('hard');
    expect((s.controllers[0].resolver as { id?: string }).id).toBe('hard');
    s.setBacking(false);
    expect(s.info().backing.enabled).toBe(false);
    s.setNumPlayers(5);
    expect(s.config.players.count).toBe(2);
    s.stop();
  });

  it('info().song.countIn is always an object, idle until a song counts in; the backing band builds nothing before start()', () => {
    const s = makeSession();
    expect(s.info().song.countIn).toEqual({ active: false, beat: 0, beats: 4 });
    expect(s.backing.ready).toBe(false);
    s.setBacking(false); // releasing a band that was never built is a no-op
    s.pause();
    s.setStandby(true);
    s.stop();
  });

  it('scores sounding events against the song clock and reports them through info()', () => {
    const s = makeSession();
    const hit = () => bus.emit({ type: 'drum.hit', t: 1, playerId: 0, pad: 'snare', velocity: 0.8 });
    hit(); // free play: not judged
    expect(s.info().players[0].score).toMatchObject({ points: 0, miss: 0, last: null });

    // Stand in for a running song clock (the real one needs an audio context).
    let song: SongContext = { ...FREEPLAY_CONTEXT, bpm: 80, beatPhase: 0.02 };
    (s as unknown as { songContext: () => SongContext }).songContext = () => song;
    hit();
    s.kick();
    expect(s.info().players[0].score).toMatchObject({ perfect: 2, combo: 2, last: 'perfect' });
    expect(s.info().band.tightness).toBe(1);

    song = { ...song, beatPhase: 0.25 };
    hit();
    expect(s.info().players[0].score).toMatchObject({ perfect: 2, miss: 1, combo: 0, bestCombo: 2 });
    expect(s.info().band.tightness).toBeCloseTo(2 / 3);

    // Events for an instrument the player is not on make no sound and no score.
    bus.emit({ type: 'guitar.strum', t: 1, playerId: 0, direction: 'down', velocity: 0.8, chord: null, chordConfidence: 0 });
    expect(s.info().players[0].score.miss).toBe(1);

    s.resetScore();
    expect(s.info().players[0].score.points).toBe(0);
    expect(s.info().band.tightness).toBe(0);

    // A new instrument starts from zero; picking the same one again changes nothing.
    hit();
    s.setInstrument('drums');
    expect(s.info().players[0].score.perfect).toBe(0);
    expect(s.info().players[0].score.miss).toBe(1);
    s.setInstrument('guitar');
    expect(s.info().players[0].score).toMatchObject({ points: 0, miss: 0, last: null });
    expect(s.info().band.tightness).toBe(0);
    s.setInstrument('drums');
    s.stop();
    hit(); // a stopped session no longer listens
    expect(s.info().players[0].score.miss).toBe(0);
  });

  it('reports the chart position, the chord and the next bar\'s chord', () => {
    const s = makeSession();
    expect(s.info().song).toMatchObject({ chord: null, nextChord: null, running: false });

    // Stand in for a running song clock (the real one needs an audio context).
    const song = getSong('stand-by-me'); // verse G Em C D | chorus G Em C D
    let bar = 0;
    let countIn = false;
    const context = (): SongContext => ({ ...FREEPLAY_CONTEXT, bpm: song.bpm, bar, beat: 2, beatPhase: 0.5, countIn, chord: song.sections[0].bars[bar % 4].chord });
    (s as unknown as { songClock: unknown }).songClock = { song, running: true, beatsPerBar: 4, context, opts: {}, dispose() {} };

    expect(s.info().song).toMatchObject({ title: 'Stand By Me', running: true, chord: 'G', nextChord: 'Em', section: 'verse' });
    expect(s.info().song).toMatchObject({ beat: 2, beatPhase: 0.5, countIn: { active: false, beat: 0, beats: 4 } });
    // During the count-in the chart sits at its top and the position moves to `countIn`.
    countIn = true;
    expect(s.info().song).toMatchObject({ bar: 0, beat: 0, beatPhase: 0, chord: 'G', nextChord: 'Em', countIn: { active: true, beat: 2, beats: 4 } });
    bus.emit({ type: 'drum.hit', t: 1, playerId: 0, pad: 'snare', velocity: 0.8 });
    expect(s.info().players[0].score).toMatchObject({ perfect: 0, good: 0, miss: 0 }); // not scored
    countIn = false;
    bar = 3;
    expect(s.info().song).toMatchObject({ chord: 'D', nextChord: 'G' });
    bar = 7; // last bar of the chart: the next chord wraps to the top
    expect(s.info().song.nextChord).toBe('G');
    bar = 8 + 5; // past the end the chart loops
    expect(s.info().song).toMatchObject({ nextChord: 'C', section: 'chorus' });
    s.stop();
    expect(s.info().song.nextChord).toBeNull();
  });

  it('pause freezes the score and resume keeps it', () => {
    const video = { pause() {}, play: async () => {} } as unknown as HTMLVideoElement;
    const canvas = { getContext: () => ({}) } as unknown as HTMLCanvasElement;
    const s = new Session(video, canvas, structuredClone(DEFAULT_CONFIG));
    s.setInstrument('drums');
    s.overlay.drawLabel = () => {};
    // Stand in for a started session: pause() is a no-op without a frame loop.
    (s as unknown as { loop: { start(): void; stop(): void } }).loop = { start() {}, stop() {} };
    const song: SongContext = { ...FREEPLAY_CONTEXT, bpm: 80, beatPhase: 0.02 };
    (s as unknown as { songContext: () => SongContext }).songContext = () => song;
    const hit = () => bus.emit({ type: 'drum.hit', t: 1, playerId: 0, pad: 'snare', velocity: 0.8 });

    hit();
    hit();
    s.pause();
    expect(s.paused).toBe(true);
    hit(); // keyboard hits still travel the bus while paused, but are not judged
    expect(s.info().players[0].score).toMatchObject({ perfect: 2, combo: 2, points: 200 });
    s.resume();
    expect(s.info().players[0].score).toMatchObject({ perfect: 2, combo: 2, points: 200 });
    hit();
    expect(s.info().players[0].score.perfect).toBe(3);
    s.stop();
  });

  it('calibrate takes the stage: it stops a running song and wakes a paused band', () => {
    const video = { pause() {}, play: async () => {} } as unknown as HTMLVideoElement;
    const canvas = { getContext: () => ({}) } as unknown as HTMLCanvasElement;
    const s = new Session(video, canvas, structuredClone(DEFAULT_CONFIG));
    s.setInstrument('drums');
    s.overlay.drawLabel = () => {};
    let loopRunning = false;
    (s as unknown as { loop: { start(): void; stop(): void } }).loop = { start: () => void (loopRunning = true), stop: () => void (loopRunning = false) };
    s.lastFrame = { t: 1, aspect: 4 / 3, hands: [], inferenceMs: 0 };
    // Stand in for a running song clock.
    let stopped = 0;
    const clock = { running: true, song: { title: 'x' }, opts: {}, pause() {}, resume() {}, dispose: () => void ((clock.running = false), stopped++) };
    (s as unknown as { songClock: unknown }).songClock = clock;
    expect(s.songRunning).toBe(true);

    s.pause();
    expect(s.paused).toBe(true);
    expect(s.calibrate()).toBe(true);
    expect(s.songRunning).toBe(false);
    expect(stopped).toBeGreaterThan(0);
    expect(s.paused).toBe(false);
    expect(loopRunning).toBe(true); // frames flow again, so the kit can follow the hands
    expect(s.info().players[0].calibration).toBe('auto');

    // Nothing to calibrate: the song is left alone.
    s.setInstrument('bass');
    clock.running = true;
    (s as unknown as { songClock: unknown }).songClock = clock;
    expect(s.calibrate()).toBe(false);
    expect(s.songRunning).toBe(true);
    (s as unknown as { songClock: unknown }).songClock = null;
    s.stop();
  });

  it('the singer stub reports an error and a toast instead of opening the mic', async () => {
    const s = makeSession();
    await s.singer.setEnabled(true);
    expect(s.info().singer.enabled).toBe(false);
    expect(s.info().singer.error).toBeTruthy();
    expect(seen.some((e) => e.type === 'ui.toast')).toBe(true);
    s.singer.setEcho(2);
    expect(s.info().singer.echo).toBe(1);
    s.stop();
  });
});
