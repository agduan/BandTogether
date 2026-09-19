import { describe, expect, it } from 'vitest';
import { createBus } from '@/core/bus';
import type { AppEvent, DrumHitEvent } from '@/core/types';

const hit: DrumHitEvent = { type: 'drum.hit', t: 1000, playerId: 0, pad: 'snare', velocity: 0.8 };

describe('event bus', () => {
  it('delivers typed events to matching subscribers only', () => {
    const bus = createBus();
    const hits: DrumHitEvent[] = [];
    const strums: unknown[] = [];
    bus.on('drum.hit', (e) => hits.push(e));
    bus.on('guitar.strum', (e) => strums.push(e));

    bus.emit(hit);

    expect(hits).toEqual([hit]);
    expect(strums).toEqual([]);
  });

  it('supports wildcard subscribers and unsubscribing', () => {
    const bus = createBus();
    const seen: AppEvent[] = [];
    const off = bus.onAny((e) => seen.push(e));

    bus.emit(hit);
    off();
    bus.emit({ ...hit, t: 2000 });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual(hit);
  });
});
