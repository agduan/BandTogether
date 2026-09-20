import type { ChordName, InstrumentId, PlayerId, PlayMode } from '@/core/types';
import type { CalibrationState } from '@/core/views';

/**
 * Everything the UI and HUD need to know about a running session, as plain
 * data from `session.info()`. Poll it (it is cheap); never compute any of this
 * in the UI. The first four fields are `HudInfo`, so a SessionInfo can be
 * handed to the Hud as is.
 */
export interface SessionInfo {
  mode: PlayMode;
  /** null until a song clock exists (HudInfo semantics); `song.title` is always set. */
  songTitle: string | null;
  songRunning: boolean;
  beatsPerBar: number;

  /** Player 0's instrument; null = none picked (just the camera picture). */
  instrument: InstrumentId | null;
  paused: boolean;
  /** The band is held while the players are edited: hands are tracked, nothing plays (see `Session.setStandby`). */
  standby: boolean;
  song: SongInfo;
  backing: { enabled: boolean; parts: { bass: boolean; pad: boolean; drums: boolean } };
  singer: SingerInfo;
  players: PlayerInfo[];
  band: {
    /** Timing quality across all players' recent events, 0..1: perfect = 1, good = 0.5, miss = 0, averaged. */
    tightness: number;
  };
}

export interface SongInfo {
  id: string;
  title: string;
  bpm: number;
  /** 0-based, keeps counting past the end of the chart (the chart loops). */
  bar: number;
  beat: number;
  /** 0..1 inside the beat. */
  beatPhase: number;
  chord: ChordName | null;
  /** Chord of the next bar (it can equal `chord`); null while no song runs. */
  nextChord: ChordName | null;
  lyric: string | null;
  nextLyric: string | null;
  section: string | null;
  /** Bars in one pass of the chart. */
  barCount: number;
  running: boolean;
  /**
   * The clicks before bar 0. While `active`, `beat` is the 0-based beat inside
   * the count-in (show `beats - beat`), `bar` / `beat` / `beatPhase` above stay
   * 0, `chord` is the chart's first chord and nothing is scored. Always an
   * object; `active` is false once the chart runs and whenever no song runs.
   */
  countIn: CountInInfo;
}

export interface CountInInfo {
  active: boolean;
  beat: number;
  /** Length of the count-in, beats (one bar). */
  beats: number;
}

export interface SingerInfo {
  enabled: boolean;
  /** false when the browser has no microphone API. */
  available: boolean;
  /** Input level, 0..1. */
  level: number;
  echo: number;
  reverb: number;
  /** Browser ID of the active or selected audio input. */
  deviceId: string;
  /** Last mic error (e.g. permission denied); null when fine. */
  error: string | null;
}

export type Judgement = 'perfect' | 'good' | 'miss';

export interface ScoreInfo {
  points: number;
  combo: number;
  bestCombo: number;
  perfect: number;
  good: number;
  miss: number;
  last: Judgement | null;
  /** Signed offset of the last event from the nearest grid line, ms (negative = early). */
  lastOffsetMs: number | null;
  /** Timing quality over this player's recent events, 0..1: perfect = 1, good = 0.5, miss = 0, averaged. */
  tightness: number;
}

export interface PlayerInfo {
  id: PlayerId;
  /** null = "None": this player holds no instrument. */
  instrument: InstrumentId | null;
  /** Hands tracked for this player in the latest frame. */
  hands: number;
  calibration: CalibrationState;
  score: ScoreInfo;
}

export const EMPTY_SCORE: ScoreInfo = {
  points: 0,
  combo: 0,
  bestCombo: 0,
  perfect: 0,
  good: 0,
  miss: 0,
  last: null,
  lastOffsetMs: null,
  tightness: 0,
};
