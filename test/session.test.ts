import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '@/app/config';
import { getSong } from '@/song/songs';
import { Session } from '@/app/session';
import { bus } from '@/core/bus';
import { FREEPLAY_CONTEXT } from '@/audio/modes';
import type { AppEvent, SongContext } from '@/core/types';
import { GuitarFx } from '@/render/fx';

/** A Session never touches the camera, model or audio context until `start()`, so fakes are enough. */
function makeSession(): Session {
  const video = {} as HTMLVideoElement;
  const canvas = { getContext: () => ({}) } as unknown as HTMLCanvasElement;
  return new Session(video, canvas, structuredClone(DEFAULT_CONFIG));
}

const seen: AppEvent[] = [];
let off = bus.onAny((e) => seen.push(e));
afterEach(() => {
  off();
  seen.length = 0;
  off = bus.onAny((e) => seen.push(e));
});

describe('Session seams', () => {
  it('starts player 0 on drums and reports it through info()', () => {
    const s = makeSession();
    const info = s.info();
    expect(info.instrument).toBe('drums');
    expect(info.players).toHaveLength(1);
    expect(info.players[0]).toMatchObject({ id: 0, instrument: 'drums', hands: 0, calibration: 'none' });
    expect(info.players[0].score.points).toBe(0);
    // HudInfo fields stay at the top level.
    expect(info).toMatchObject({ mode: 'easy', songTitle: null, songRunning: false, beatsPerBar: 4, paused: false });
    expect(info.song).toMatchObject({ id: 'viva-la-vida', bpm: 138, barCount: 20, running: false, lyric: null });
    expect(info.backing.enabled).toBe(true);
    expect(info.singer).toMatchObject({ enabled: false, level: 0, error: null });
    s.stop();
  });

  it('setInstrument swaps the controller, uses registered guitar art, and stays silent', () => {
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

    // An instrument that can calibrate gets the latest frame.
    const inst = s.controllers[0].instrument;
    inst.calibrate = () => true;
    s.lastFrame = { t: 1, aspect: 4 / 3, hands: [], inferenceMs: 0 };
    expect(s.calibrate()).toBe(true);
    expect(seen.filter((e) => e.type === 'ui.toast')[1]).toMatchObject({ text: 'Calibrated', kind: 'success' });
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
    const song = getSong('campfire'); // G D Em C | G D Am D
    let bar = 0;
    const context = (): SongContext => ({ ...FREEPLAY_CONTEXT, bpm: song.bpm, bar, chord: song.sections[0].bars[bar % 4].chord });
    (s as unknown as { songClock: unknown }).songClock = { song, running: true, beatsPerBar: 4, context, opts: {}, dispose() {} };

    expect(s.info().song).toMatchObject({ title: 'Campfire Loop', running: true, chord: 'G', nextChord: 'D', section: 'loop' });
    bar = 3;
    expect(s.info().song).toMatchObject({ chord: 'C', nextChord: 'G' });
    bar = 7; // last bar of the chart: the next chord wraps to the top
    expect(s.info().song.nextChord).toBe('G');
    bar = 8 + 5; // past the end the chart loops
    expect(s.info().song).toMatchObject({ nextChord: 'Am', section: 'turnaround' });
    s.stop();
    expect(s.info().song.nextChord).toBeNull();
  });

  it('pause freezes the score and resume keeps it', () => {
    const video = { pause() {}, play: async () => {} } as unknown as HTMLVideoElement;
    const canvas = { getContext: () => ({}) } as unknown as HTMLCanvasElement;
    const s = new Session(video, canvas, structuredClone(DEFAULT_CONFIG));
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
