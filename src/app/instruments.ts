import type { ToneAudioNode } from 'tone';
import type { Config } from './config';
import type { ChordName, Detector, Instrument, InstrumentId, PlayerId, PlayMode, SongContext, TrackId, VisionFrame } from '@/core/types';
import type { InstrumentView } from '@/core/views';
import { DrumsVoice } from '@/audio/voices/drumsVoice';
import { BassVoice } from '@/audio/voices/bassVoice';
import { GuitarVoice } from '@/audio/voices/guitarVoice';
import { BassPluckDetector } from '@/detectors/bassDetector';
import { BassOverlay } from '@/detectors/bassOverlay';
import { DebugOverlay } from '@/detectors/debugOverlay';
import { DrumHitDetector, kitZones } from '@/detectors/drumHitDetector';
import { FULL_FRAME, GuitarStrumDetector, type BandLayout, type PlayerRegion } from '@/detectors/strumDetector';
import { createFx, type FxLayer } from '@/render/fxRegistry';

/** Instruments a player can pick, in picker order. */
export const INSTRUMENT_IDS = ['drums', 'guitar', 'bass'] as const satisfies readonly InstrumentId[];
export type PlayableInstrumentId = (typeof INSTRUMENT_IDS)[number];

/**
 * Modes each instrument supports. Guitar is easy only (no chord classifier);
 * if the toggle is left on hard it still plays the chart chord. So does the
 * bass; its `hard` entry goes with the K9b cleanup.
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
  /** The slice of the frame this player owns (default: all of it; the session passes a half when two play). */
  region?: () => PlayerRegion;
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
    default:
      // Ids reach here from the URL and the UI, so an unknown one must fail loudly, before anything is torn down.
      throw new Error(`unknown instrument "${String(id)}"`);
  }
}

/** The registered FX for an instrument; when there is none, `fallback`, else the detectors' debug drawing. */
function overlayFor(id: InstrumentId, deps: InstrumentDeps, detectors: Detector[], view: () => InstrumentView | null, fallback?: () => FxLayer): FxLayer {
  return createFx(id, deps.config, deps.playerId ?? 0, view) ?? fallback?.() ?? new DebugOverlay(detectors);
}

/**
 * The config as one drummer's overlay should see it. `DrumsFx` draws from
 * `kitGeometry(config.drum)`, not from the view, so it gets a config whose
 * `drum.kit` and `drum.padHalfHeight` are this player's placed kit; every
 * other key falls through to the shared config, so sliders stay live. One
 * view per player: two drummers draw two kits.
 */
function drumConfigFor(config: Config, detector: DrumHitDetector): Config {
  const drum: Config['drum'] = Object.create(config.drum, {
    kit: { get: () => detector.kit, enumerable: true },
    padHalfHeight: { get: () => detector.padHalfHeight, enumerable: true },
  });
  return Object.create(config, { drum: { value: drum, enumerable: true } });
}

/** Body-relative kit: a default spot inside the player's region; `calibrate` toggles placing it on the player. */
export function createDrums(deps: InstrumentDeps): Instrument {
  const { config, output, playerId = 0, region } = deps;
  const detector = new DrumHitDetector(config, playerId, region);
  const view = (): InstrumentView => ({
    instrument: 'drums',
    pads: detector.geometry,
    anchor: detector.anchor,
    calibration: detector.calibration,
  });
  const fx = overlayFor('drums', { ...deps, config: drumConfigFor(config, detector) }, [detector], view);
  return {
    id: 'drums',
    detectors: [detector],
    voice: new DrumsVoice(output),
    // The fixed layout at 4:3; nobody reads zones, the live pads are in the view.
    zones: kitZones(config.drum, 4 / 3),
    overlay: fx,
    view,
    calibrate: (frame) => detector.calibrate(frame),
    resetCalibration: () => detector.resetCalibration(),
    dispose: () => fx.dispose?.(),
  };
}

type BandPlacement = Pick<BandLayout, 'bandY' | 'bandXMin' | 'bandXMax'>;
/** A calibrated band is at least this much wider than the hand it was placed under. */
const HAND_MARGIN = 1.2;

/**
 * One guitar's (or bass's) band. Until its player places it, it is the shared
 * `config.strum` (`config.bass`) band, read live; a placement belongs to this
 * instrument alone, so two guitarists move two bands. `bandConfigFor` shows it
 * to the detector.
 */
interface BandSlot {
  placed: BandPlacement | null;
}

/**
 * The config as one guitar's (`strum`) or bass's (`bass`) detector should see
 * it: that section's `bandY / bandXMin / bandXMax` are this instrument's
 * placement once it has one; every other key, and the band itself until then,
 * falls through to the shared config, so the thresholds stay live.
 */
function bandConfigFor(config: Config, section: 'strum' | 'bass', slot: BandSlot): Config {
  const key = (k: keyof BandPlacement) => ({ get: () => slot.placed?.[k] ?? config[section][k], enumerable: true });
  const view = Object.create(config[section], { bandY: key('bandY'), bandXMin: key('bandXMin'), bandXMax: key('bandXMax') });
  return Object.create(config, { [section]: { value: view, enumerable: true } });
}

/**
 * Where to put the strum band so it sits under the player's strumming hand,
 * as fractions of the player's region. Across, the band is centred on the
 * whole hand (wrist to fingertips), which is what the player sees; a
 * palm-centred band looks shifted toward the bridge, because a strumming hand
 * points its fingers at the neck. It is never narrower than the hand, so the
 * palm (the point the detector tracks) always has room inside it, and it never
 * leaves the region. Up and down, the centreline sits on the palm, the point
 * that crosses it. Null when the player has no hand in view.
 */
function placeBand(strum: BandLayout, frame: VisionFrame, playerId: PlayerId, strumTrackId: TrackId | null, region: PlayerRegion): BandPlacement | null {
  // The strummer if the roles know one, else the hand furthest to the strumming side (screen-right unless lefty).
  const hands = frame.hands.filter((h) => h.playerId === playerId).sort((a, b) => (strum.lefty ? a.palm.x - b.palm.x : b.palm.x - a.palm.x));
  const hand = hands.find((h) => h.trackId === strumTrackId) ?? hands[0];
  if (!hand) return null;
  const width = region.x1 - region.x0;
  const inRegion = (x: number) => (x / frame.aspect - region.x0) / width;
  const xs = hand.raw.map((p) => p.x);
  const left = inRegion(Math.min(hand.palm.x, ...xs));
  const right = inRegion(Math.max(hand.palm.x, ...xs));
  const half = Math.min(0.5, Math.max((strum.bandXMax - strum.bandXMin) / 2, ((right - left) / 2) * HAND_MARGIN));
  // Config x is written for a right-handed player; `lefty` mirrors it at read time.
  const x = (left + right) / 2;
  const cx = Math.min(1 - half, Math.max(half, strum.lefty ? 1 - x : x));
  return {
    bandXMin: cx - half,
    bandXMax: cx + half,
    bandY: Math.min(1 - strum.bandHalfHeight, Math.max(strum.bandHalfHeight, hand.palm.y)),
  };
}

/** Easy mode only: a strum plays the chart chord, or the free-play loop when no song runs. */
export function createGuitar(deps: InstrumentDeps): Instrument {
  const { config, output, playerId = 0, song, region = () => FULL_FRAME } = deps;
  const slot: BandSlot = { placed: null };
  const detector = new GuitarStrumDetector(bandConfigFor(config, 'strum', slot), playerId, region);
  const voice = new GuitarVoice(output, () => config.guitar);
  const view = (): InstrumentView => ({
    instrument: 'guitar',
    band: detector.band,
    // The chart chord; in free play, the loop chord that last sounded.
    chord: song?.().chord ?? voice.chord,
    ...detector.roles,
  });
  const fx = overlayFor('guitar', deps, [detector], view);
  return {
    id: 'guitar',
    detectors: [detector],
    voice,
    zones: [],
    overlay: fx,
    view,
    calibrate: (frame) => {
      // Measured against the shared band, so the default width is what a small, far hand gets back.
      const placed = placeBand(config.strum, frame, playerId, detector.roles.strumTrackId, region());
      if (placed) slot.placed = placed;
      return placed !== null;
    },
    resetCalibration: () => void (slot.placed = null),
    dispose: () => fx.dispose?.(),
  };
}

/** 'Em7' is 'E', 'F#m' is 'F#': what the bass plays under a chord, for its overlay. */
function rootName(chord: ChordName | null): string | null {
  return chord ? (/^[A-G][#b]?/.exec(chord.trim())?.[0] ?? null) : null;
}

/**
 * A one-note guitar, strum only: every stroke across the bass band, down or
 * up, plays the root of the chart chord (the free-play loop's when no song
 * runs). Placed per player with `calibrate`, like the guitar.
 */
export function createBass(deps: InstrumentDeps): Instrument {
  const { config, output, playerId = 0, song, region = () => FULL_FRAME } = deps;
  const slot: BandSlot = { placed: null };
  const detector = new BassPluckDetector(bandConfigFor(config, 'bass', slot), playerId, region);
  const voice = new BassVoice(output, () => config.bass);
  const view = (): InstrumentView => ({
    instrument: 'bass',
    band: detector.band,
    neck: detector.neck,
    // No fret-hand bins: the chart picks the note.
    activeBin: null,
    note: voice.note,
    root: rootName(song?.().chord ?? voice.chord),
  });
  // Until render/fxRegistry.ts has bass art, the bass draws its own one-string version of the guitar.
  const fx = overlayFor('bass', deps, [detector], view, () => new BassOverlay(playerId, view));
  return {
    id: 'bass',
    detectors: [detector],
    voice,
    zones: [],
    overlay: fx,
    view,
    calibrate: (frame) => {
      const placed = placeBand({ ...config.bass, lefty: config.strum.lefty }, frame, playerId, detector.roles.strumTrackId, region());
      if (placed) slot.placed = placed;
      return placed !== null;
    },
    resetCalibration: () => void (slot.placed = null),
    dispose: () => fx.dispose?.(),
  };
}
