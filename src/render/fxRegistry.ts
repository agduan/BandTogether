import type { Config } from '@/app/config';
import type { InstrumentId, OverlayLayer, PlayerId } from '@/core/types';
import type { InstrumentView } from '@/core/views';
import { DrumsFx, GuitarFx } from './fx';

/** An overlay that may hold bus subscriptions; `dispose` is called when the instrument is swapped out. */
export type FxLayer = OverlayLayer & { dispose?(): void };

/**
 * Art registry: the one place an instrument's overlay is chosen. Return null
 * and the instrument falls back to its detectors' debug drawing, so new art
 * is registered here and never needs an edit in app/instruments.ts.
 *
 * `view()` is the instrument's live geometry and state (core/views.ts): poll
 * it inside `draw`. It returns the variant matching `id`, or null early on.
 */
export function createFx(id: InstrumentId, config: Config, playerId: PlayerId, view: () => InstrumentView | null): FxLayer | null {
  switch (id) {
    case 'drums':
      return new DrumsFx(config, playerId);
    case 'guitar':
      return new GuitarFx(playerId, view);
    default:
      return null;
  }
}
