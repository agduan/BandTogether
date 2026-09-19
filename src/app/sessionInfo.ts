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

  /** Player 0's instrument. */
  instrument: InstrumentId;
  paused: boolean;
  song: SongInfo;
  backing: { enabled: boolean };
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
  lyric: string | null;
  nextLyric: string | null;
  section: string | null;
  /** Bars in one pass of the chart. */
  barCount: number;
  running: boolean;
}

export interface SingerInfo {
  enabled: boolean;
  /** false when the browser has no microphone API. */
  available: boolean;
  /** Input level, 0..1. */
  level: number;
  echo: number;
  reverb: number;
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
  instrument: InstrumentId;
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
