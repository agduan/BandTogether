import type { ToneAudioNode } from 'tone';
import type { Config } from './config';
import type { Instrument, InstrumentId, PlayerId } from '@/core/types';
import { DrumsVoice } from '@/audio/voices/drumsVoice';
import { DrumHitDetector, kitZones } from '@/detectors/drumHitDetector';
import { DrumsFx } from '@/render/fx';

export interface InstrumentDeps {
  /** Shared, live-mutable config. */
  config: Config;
  /** Master output the voice connects to (available once the audio engine started). */
  output: () => ToneAudioNode;
  playerId?: PlayerId;
}

/**
 * Instrument registry. Each factory bundles the detectors, voice, zones and
 * overlay for one instrument; the controller wires them to a player and mode.
 * Guitar arrives in commit 11, keyboard in commit 25.
 */
export function createInstrument(id: InstrumentId, deps: InstrumentDeps): Instrument {
  switch (id) {
    case 'drums':
      return createDrums(deps);
    default:
      throw new Error(`instrument "${id}" is not available yet`);
  }
}

export function createDrums({ config, output, playerId = 0 }: InstrumentDeps): Instrument {
  const fx = new DrumsFx(config, playerId);
  return {
    id: 'drums',
    detectors: [new DrumHitDetector(config, playerId)],
    voice: new DrumsVoice(output),
    // Layout at the default 4:3 aspect; detectors and FX recompute per frame.
    zones: kitZones(config.drum, 4 / 3),
    overlay: fx,
    dispose: () => fx.dispose(),
  };
}
