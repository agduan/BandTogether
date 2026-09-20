import { bus } from '@/core/bus';
import type { InstrumentEvent } from '@/core/types';

/**
 * Keyboard event injector: fires InstrumentEvents onto the bus without a
 * camera, so the audio path and HUD can be tested from the keyboard.
 * Active only while the debug panel is open.
 */
export const INJECTOR_KEYS: ReadonlyArray<{ key: string; describe: string; make: (t: number) => InstrumentEvent }> = [
  { key: '1', describe: 'kick', make: (t) => ({ type: 'drum.hit', t, playerId: 0, pad: 'kick', velocity: 0.9 }) },
  { key: '2', describe: 'snare', make: (t) => ({ type: 'drum.hit', t, playerId: 0, pad: 'snare', velocity: 0.8 }) },
  { key: '3', describe: 'hihat', make: (t) => ({ type: 'drum.hit', t, playerId: 0, pad: 'hihat', velocity: 0.6 }) },
  { key: '4', describe: 'tom1', make: (t) => ({ type: 'drum.hit', t, playerId: 0, pad: 'tom1', velocity: 0.8 }) },
  { key: '5', describe: 'tom2', make: (t) => ({ type: 'drum.hit', t, playerId: 0, pad: 'tom2', velocity: 0.8 }) },
  { key: '6', describe: 'crash', make: (t) => ({ type: 'drum.hit', t, playerId: 0, pad: 'crash', velocity: 0.9 }) },
  {
    key: 'j',
    describe: 'strum down',
    make: (t) => ({ type: 'guitar.strum', t, playerId: 0, direction: 'down', velocity: 0.8, chord: null }),
  },
  {
    key: 'k',
    describe: 'strum up',
    make: (t) => ({ type: 'guitar.strum', t, playerId: 0, direction: 'up', velocity: 0.6, chord: null }),
  },
  {
    key: 'n',
    describe: 'bass down',
    make: (t) => ({ type: 'bass.pluck', t, playerId: 0, direction: 'down', velocity: 0.8, pitchBin: null }),
  },
  {
    key: 'm',
    describe: 'bass up',
    make: (t) => ({ type: 'bass.pluck', t, playerId: 0, direction: 'up', velocity: 0.6, pitchBin: null }),
  },
];

/** Returns true if the key was consumed. */
export function injectFromKey(key: string, t = performance.now()): boolean {
  const entry = INJECTOR_KEYS.find((k) => k.key === key);
  if (!entry) return false;
  bus.emit(entry.make(t));
  return true;
}
