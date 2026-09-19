/**
 * Instrument views: the live geometry and state an instrument publishes for
 * whoever draws it. Overlays (render/*) and `session.info()` read these, so
 * art never has to import a detector or recompute where a pad or band is.
 * All geometry is display space, h-units (see core/types.ts).
 */
import type { ChordName, PadId, TrackId, Vec2 } from './types';

/** One drum pad: x-range and strike line. */
export interface PadGeometry {
  id: PadId;
  x0: number;
  x1: number;
  y: number;
}

/** Where a body-relative kit sits: centre and the palm-size unit its offsets scale by. */
export interface KitAnchor {
  cx: number;
  cy: number;
  unit: number;
}

/**
 * 'none': fixed layout, nothing to calibrate. 'auto': following the player.
 * 'locked': `calibrate()` snapped height and scale.
 */
export type CalibrationState = 'none' | 'auto' | 'locked';

export interface DrumsView {
  instrument: 'drums';
  pads: PadGeometry[];
  /** null while the kit is a fixed screen layout. */
  anchor: KitAnchor | null;
  calibration: CalibrationState;
}

/** The horizontal band a strum or pluck crosses: x-range, centreline, half height. */
export interface BandGeometry {
  x0: number;
  x1: number;
  y: number;
  halfHeight: number;
}

export interface GuitarView {
  instrument: 'guitar';
  band: BandGeometry;
  /** The CHART chord (there is no classifier); null in free play. */
  chord: ChordName | null;
  strumTrackId: TrackId | null;
  fretTrackId: TrackId | null;
}

/** The bass neck the fret hand slides along, split into `bins` equal pitch bins from `nut`. */
export interface NeckGeometry {
  nut: Vec2;
  body: Vec2;
  bins: number;
}

export interface BassView {
  instrument: 'bass';
  band: BandGeometry;
  neck: NeckGeometry;
  /** Hard mode: bin under the fret hand; null = none. */
  activeBin: number | null;
  /** Last note played, e.g. 'G1'. */
  note: string | null;
}

export type InstrumentView = DrumsView | GuitarView | BassView;
