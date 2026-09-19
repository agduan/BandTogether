import type { ToneAudioNode } from 'tone';
import type { Config } from './config';
import type { Detector, Instrument, InstrumentId, PlayerId, PlayMode, SongContext } from '@/core/types';
import type { InstrumentView } from '@/core/views';
import { DrumsVoice } from '@/audio/voices/drumsVoice';
import { SilentVoice } from '@/audio/voices/silentVoice';
import { BassPluckDetector } from '@/detectors/bassDetector';
import { DebugOverlay } from '@/detectors/debugOverlay';
import { DrumHitDetector, kitZones } from '@/detectors/drumHitDetector';
import { GuitarStrumDetector } from '@/detectors/strumDetector';
import { createFx, type FxLayer } from '@/render/fxRegistry';

/** Instruments a player can pick, in picker order. */
export const INSTRUMENT_IDS = ['drums', 'guitar', 'bass'] as const satisfies readonly InstrumentId[];
export type PlayableInstrumentId = (typeof INSTRUMENT_IDS)[number];

/**
 * Modes each instrument supports. Guitar is easy only (no chord classifier);
 * if the toggle is left on hard it still plays the chart chord.
 */
export const INSTRUMENT_MODES: Record<PlayableInstrumentId, readonly PlayMode[]> = {
  drums: ['easy', 'hard'],
  guitar: ['easy'],
  bass: ['easy', 'hard'],
};

export interface InstrumentDeps {
  /** Shared, live-mutable config. */
  config: Config;
  /** Master output the voice connects to (available once the audio engine started). */
  output: () => ToneAudioNode;
  playerId?: PlayerId;
  /** Song position, for views that show the chart chord. */
  song?: () => SongContext;
}

/**
 * Instrument registry. Each factory bundles the detectors, voice, zones and
 * overlay for one instrument; the controller wires them to a player and mode.
 * Art comes from render/fxRegistry.ts; an instrument without art there draws
 * its detectors' debug geometry instead.
 */
export function createInstrument(id: InstrumentId, deps: InstrumentDeps): Instrument {
  switch (id) {
    case 'drums':
      return createDrums(deps);
    case 'guitar':
      return createGuitar(deps);
    case 'bass':
      return createBass(deps);
    case 'keyboard':
      throw new Error('the keyboard was cut from the plan');
  }
}

/** The registered FX for an instrument, or the debug overlay when there is none. */
function overlayFor(id: InstrumentId, deps: InstrumentDeps, detectors: Detector[], view: () => InstrumentView | null): FxLayer {
  return createFx(id, deps.config, deps.playerId ?? 0, view) ?? new DebugOverlay(detectors);
}

export function createDrums(deps: InstrumentDeps): Instrument {
  const { config, output, playerId = 0 } = deps;
  const detector = new DrumHitDetector(config, playerId);
  // Fixed screen layout until K1 makes the kit body-relative (anchor, calibration).
  const view = (): InstrumentView => ({ instrument: 'drums', pads: detector.geometry, anchor: null, calibration: 'none' });
  const fx = overlayFor('drums', deps, [detector], view);
  return {
    id: 'drums',
    detectors: [detector],
    voice: new DrumsVoice(output),
    // Layout at the default 4:3 aspect; detectors and FX recompute per frame.
    zones: kitZones(config.drum, 4 / 3),
    overlay: fx,
    view,
    dispose: () => fx.dispose?.(),
  };
}

/** Silent until rows 10 (strum detector) and 11 (guitar voice, chart voicings). */
export function createGuitar(deps: InstrumentDeps): Instrument {
  const { config, playerId = 0, song } = deps;
  const detector = new GuitarStrumDetector(config, playerId);
  const view = (): InstrumentView => ({
    instrument: 'guitar',
    band: detector.band,
    chord: song?.().chord ?? null,
    strumTrackId: null,
    fretTrackId: null,
  });
  const fx = overlayFor('guitar', deps, [detector], view);
  return {
    id: 'guitar',
    detectors: [detector],
    voice: new SilentVoice('guitar'),
    zones: [],
    overlay: fx,
    view,
    dispose: () => fx.dispose?.(),
  };
}

/** Silent until K5 (pluck detector, bass voice). */
export function createBass(deps: InstrumentDeps): Instrument {
  const { config, playerId = 0 } = deps;
  const detector = new BassPluckDetector(config, playerId);
  const view = (): InstrumentView => ({
    instrument: 'bass',
    band: detector.band,
    neck: detector.neck,
    activeBin: null,
    note: null,
  });
  const fx = overlayFor('bass', deps, [detector], view);
  return {
    id: 'bass',
    detectors: [detector],
    voice: new SilentVoice('bass'),
    zones: [],
    overlay: fx,
    view,
    dispose: () => fx.dispose?.(),
  };
}
