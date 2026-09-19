import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '@/app/config';
import { Session } from '@/app/session';
import { bus } from '@/core/bus';
import type { AppEvent } from '@/core/types';
import { DebugOverlay } from '@/detectors/debugOverlay';

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
    expect(info.song).toMatchObject({ id: 'saints', bpm: 120, barCount: 16, running: false, lyric: null });
    expect(info.backing.enabled).toBe(true);
    expect(info.singer).toMatchObject({ enabled: false, level: 0, error: null });
    s.stop();
  });

  it('setInstrument swaps the controller, falls back to the debug overlay, and stays silent', () => {
    const s = makeSession();
    const drums = s.controllers[0];
    s.setInstrument('guitar');
    const guitar = s.controllers[0];
    expect(guitar).not.toBe(drums);
    expect(guitar.instrument.id).toBe('guitar');
    expect(guitar.instrument.overlay).toBeInstanceOf(DebugOverlay);
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
