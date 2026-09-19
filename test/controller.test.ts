import { afterEach, describe, expect, it } from 'vitest';
import { InstrumentController } from '@/app/controller';
import { HardMode } from '@/audio/modes';
import { bus } from '@/core/bus';
import type { AppEvent, Detector, DrumHitEvent, Instrument, InstrumentEvent, VisionFrame, Voice } from '@/core/types';

const frame = (t: number): VisionFrame => ({ t, aspect: 4 / 3, hands: [], inferenceMs: 5 });

/** Detector that emits one snare hit on every frame whose t is in `hitAt`. */
function scriptedDetector(hitAt: number[]): Detector<DrumHitEvent> {
  return {
    id: 'scripted',
    update: (f) => (hitAt.includes(f.t) ? [{ type: 'drum.hit', t: f.t, playerId: 0, pad: 'snare', velocity: 0.7 }] : []),
    reset: () => {},
  };
}

function fakeVoice(): Voice & { triggers: unknown[]; released: number } {
  return {
    id: 'drums',
    triggers: [],
    released: 0,
    load: () => Promise.resolve(),
    trigger(sound) {
      this.triggers.push(sound);
    },
    releaseAll() {
      this.released++;
    },
  };
}

function setup(hitAt: number[] = []) {
  const voice = fakeVoice();
  const instrument: Instrument = {
    id: 'drums',
    detectors: [scriptedDetector(hitAt)],
    voice,
    zones: [],
    overlay: { draw: () => {} },
  };
  const stamps: InstrumentEvent[] = [];
  const controller = new InstrumentController({
    playerId: 0,
    instrument,
    resolver: new HardMode(),
    audio: { stamp: (e) => stamps.push(e) },
  });
  return { controller, voice, stamps };
}

const seen: AppEvent[] = [];
let off = bus.onAny((e) => seen.push(e));
afterEach(() => {
  off();
  seen.length = 0;
  off = bus.onAny((e) => seen.push(e));
});

describe('InstrumentController', () => {
  it('runs detectors per frame, publishes hits, resolves them, and triggers the voice once', () => {
    const { controller, voice, stamps } = setup([1033]);
    controller.onFrame(frame(1000));
    controller.onFrame(frame(1033));
    controller.onFrame(frame(1066));

    expect(seen.filter((e) => e.type === 'drum.hit')).toHaveLength(1);
    expect(voice.triggers).toEqual([{ sample: 'snare', velocity: 0.7 }]);
    expect(stamps.map((s) => s.t)).toEqual([1033]);
    controller.dispose();
  });

  it('plays injected bus events for its player and ignores other players', () => {
    const { controller, voice } = setup();
    bus.emit({ type: 'drum.hit', t: 1, playerId: 0, pad: 'kick', velocity: 0.9 });
    bus.emit({ type: 'drum.hit', t: 2, playerId: 1, pad: 'kick', velocity: 0.9 });
    bus.emit({ type: 'guitar.strum', t: 3, playerId: 0, direction: 'down', velocity: 0.5, chord: null, chordConfidence: 0 });
    expect(voice.triggers).toEqual([{ sample: 'kick', velocity: 0.9 }]);
    controller.dispose();
  });

  it('stops playing after dispose and releases the voice on reset', () => {
    const { controller, voice } = setup();
    controller.reset();
    expect(voice.released).toBe(1);
    controller.dispose();
    bus.emit({ type: 'drum.hit', t: 1, playerId: 0, pad: 'kick', velocity: 0.9 });
    expect(voice.triggers).toHaveLength(0);
  });
});
