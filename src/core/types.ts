/**
 * Core types shared by every module. Read the conventions before adding to it.
 *
 * CONVENTIONS (do not break these):
 * - Geometry is in frame-height units ("h"): y in [0, 1], x in [0, aspect].
 *   Velocities are in h/s. Thresholds are therefore resolution-independent.
 *   Layout configs are written as fractions of width/height and converted once.
 * - The frame adapter mirrors x ONCE into what the player sees on screen.
 *   Nothing downstream mirrors again.
 * - One clock: performance.now() (or the video-frame-callback timestamp).
 *   Never Date.now() or a frame counter.
 * - Detectors are pure state machines over frames: replayable and testable.
 * - MediaPipe's handedness label is a PRIOR only; roles come from geometry.
 */

export type Vec2 = { x: number; y: number };
export type Vec3 = { x: number; y: number; z: number };

export type PlayerId = number;
export type TrackId = number;

export type Handedness = 'Left' | 'Right';
export type HandRole = 'strum' | 'fret' | 'drum' | 'piano';

/** MediaPipe hand landmark indices (21 per hand). */
export const LM = {
  WRIST: 0,
  THUMB_CMC: 1,
  THUMB_MCP: 2,
  THUMB_IP: 3,
  THUMB_TIP: 4,
  INDEX_MCP: 5,
  INDEX_PIP: 6,
  INDEX_DIP: 7,
  INDEX_TIP: 8,
  MIDDLE_MCP: 9,
  MIDDLE_PIP: 10,
  MIDDLE_DIP: 11,
  MIDDLE_TIP: 12,
  RING_MCP: 13,
  RING_PIP: 14,
  RING_DIP: 15,
  RING_TIP: 16,
  PINKY_MCP: 17,
  PINKY_PIP: 18,
  PINKY_DIP: 19,
  PINKY_TIP: 20,
} as const;

export const HAND_LANDMARK_COUNT = 21;

/** Landmark pairs that form the hand skeleton, for drawing. */
export const HAND_CONNECTIONS: ReadonlyArray<readonly [number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

/** One tracked hand in one frame, in display space (h-units, mirrored once). */
export interface HandFrame {
  /** Frame timestamp, ms (performance.now clock). */
  t: number;
  /** Time since this track's previous frame, ms. 0 on a new or gapped track. */
  dt: number;
  trackId: TrackId;
  playerId: PlayerId;
  /** Corrected + majority-voted MediaPipe label. A prior only. */
  handedness: Handedness;
  handednessScore: number;
  role?: HandRole;
  /** 21 landmarks, unsmoothed. Triggers and velocities read this. */
  raw: Vec2[];
  /** 21 landmarks, One-Euro smoothed. Rendering and hover logic read this. */
  smooth: Vec2[];
  /** 21 world landmarks in meters, hand-centered. Angles/features read this. */
  world: Vec3[];
  /** Mean of landmarks 0, 5, 9, 13, 17 (raw). */
  palm: Vec2;
  /** Palm velocity, h/s (0,0 when dt is 0). */
  palmVel: Vec2;
  /** |lm9 - lm0| in h. Used for scale normalization and stick length. */
  palmSize: number;
}

export interface VisionFrame {
  t: number;
  /** videoWidth / videoHeight; x ranges over [0, aspect]. */
  aspect: number;
  hands: HandFrame[];
  inferenceMs: number;
}

// ---------------------------------------------------------------------------
// Events. Instruments emit InstrumentEvents; the audio engine, renderer,
// recorder and HUD subscribe through core/bus.ts.
// ---------------------------------------------------------------------------

export type ChordName = string;
export type PadId = string;
export type StrumDirection = 'down' | 'up';

export interface DrumHitEvent {
  type: 'drum.hit';
  t: number;
  playerId: PlayerId;
  pad: PadId;
  /** 0..1 */
  velocity: number;
}

export interface StrumEvent {
  type: 'guitar.strum';
  t: number;
  playerId: PlayerId;
  direction: StrumDirection;
  /** 0..1 */
  velocity: number;
  /** Active chord at strum onset; null = unknown / none. */
  chord: ChordName | null;
  chordConfidence: number;
}

/** Emitted on label change only, for the HUD. */
export interface ChordEvent {
  type: 'guitar.chord';
  t: number;
  playerId: PlayerId;
  chord: ChordName | null;
  confidence: number;
}

export interface PressEvent {
  type: 'piano.press';
  t: number;
  playerId: PlayerId;
  finger: number;
  keyZone: number;
  velocity: number;
}

export interface ReleaseEvent {
  type: 'piano.release';
  t: number;
  playerId: PlayerId;
  finger: number;
}

export type InstrumentEvent = DrumHitEvent | StrumEvent | ChordEvent | PressEvent | ReleaseEvent;

/** Non-instrument events that also travel on the bus. */
export interface VisionFrameEvent {
  type: 'vision.frame';
  frame: VisionFrame;
}

export interface BeatEvent {
  type: 'song.beat';
  t: number;
  bar: number;
  beat: number;
  chord: ChordName | null;
}

/** Stamped by the audio engine when a sound is scheduled, for the latency meter. */
export interface AudioPlayedEvent {
  type: 'audio.played';
  /** Timestamp of the vision frame that caused the sound. */
  frameT: number;
  /** When the detector emitted the event. */
  detectT: number;
  /** When the audio engine scheduled it. */
  audioT: number;
  source: InstrumentEvent['type'];
}

export type AppEvent = InstrumentEvent | VisionFrameEvent | BeatEvent | AudioPlayedEvent;
export type AppEventType = AppEvent['type'];

// ---------------------------------------------------------------------------
// Detector / instrument / mode contracts.
// ---------------------------------------------------------------------------

export interface Detector<E extends InstrumentEvent = InstrumentEvent> {
  readonly id: string;
  /** Pure: consumes one frame, returns zero or more events. Replayable. */
  update(frame: VisionFrame): E[];
  reset(): void;
  debugDraw?(ctx: CanvasRenderingContext2D, toPx: (v: Vec2) => Vec2): void;
}

/** What the song clock exposes to note resolvers. */
export interface SongContext {
  bpm: number;
  bar: number;
  beat: number;
  /** Fractional position inside the beat, 0..1. */
  beatPhase: number;
  chord: ChordName | null;
  key: string;
}

/** A "mode": turns gesture events into concrete notes. EasyMode | HardMode. */
export interface NoteResolver {
  resolveStrum(e: StrumEvent, song: SongContext): { notes: (string | null)[]; velocities: number[] };
  resolveDrum(e: DrumHitEvent, song: SongContext): { sample: string; velocity: number };
  resolvePress(e: PressEvent, song: SongContext): { note: string; velocity: number };
}

export type InstrumentId = 'guitar' | 'drums' | 'keyboard';
export type PlayMode = 'easy' | 'hard';

/** A screen-space region (h-units) an instrument draws and reasons about. */
export interface Zone {
  id: string;
  /** Axis-aligned box in display space. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface OverlayLayer {
  draw(ctx: CanvasRenderingContext2D, frame: VisionFrame, toPx: (v: Vec2) => Vec2): void;
}

export interface Voice {
  readonly id: InstrumentId;
  load(): Promise<void>;
  /** Trigger a resolved sound; `when` is an AudioContext time or undefined for now. */
  trigger(sound: { notes?: (string | null)[]; sample?: string; velocities?: number[]; velocity?: number }, when?: number): void;
  releaseAll(): void;
}

export interface Instrument {
  readonly id: InstrumentId;
  detectors: Detector[];
  voice: Voice;
  zones: Zone[];
  overlay: OverlayLayer;
  /** Release bus subscriptions and other resources. */
  dispose?(): void;
}

// ---------------------------------------------------------------------------
// Songs.
// ---------------------------------------------------------------------------

export interface SongBar {
  chord: ChordName;
  lyric?: string;
}

export interface SongSection {
  name: string;
  bars: SongBar[];
}

export interface Song {
  title: string;
  bpm: number;
  key: string;
  timeSig: [number, number];
  sections: SongSection[];
  backingTrackUrl?: string;
}
