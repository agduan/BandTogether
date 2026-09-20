import { describe, expect, it } from 'vitest';
import { INJECTOR_KEYS, injectFromKey } from '@/app/injector';
import { bus } from '@/core/bus';
import type { AppEvent } from '@/core/types';

describe('keyboard injector', () => {
  it('n and m strum the bass down and up', () => {
    const seen: AppEvent[] = [];
    const off = bus.onAny((e) => seen.push(e));
    expect(injectFromKey('n', 10)).toBe(true);
    expect(injectFromKey('m', 20)).toBe(true);
    expect(injectFromKey('z', 30)).toBe(false);
    off();
    expect(seen).toEqual([
      { type: 'bass.strum', t: 10, playerId: 0, direction: 'down', velocity: 0.8 },
      { type: 'bass.strum', t: 20, playerId: 0, direction: 'up', velocity: 0.6 },
    ]);
  });

  it('never binds one key twice', () => {
    const keys = INJECTOR_KEYS.map((k) => k.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
