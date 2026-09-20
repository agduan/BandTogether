import type { ChordName } from '@/core/types';

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;
const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11] as const;
const CHORD_DEGREES = [0, 1, 2, 3, 4, 5] as const;
const CHORD_QUALITIES = [false, true, true, false, false, true] as const;
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88] as const;
const DEFAULT_KEY_ROOT = 7; // G major: friendly open guitar voicings while auto-detection warms up.

export const MAJOR_KEY_OPTIONS = NOTE_NAMES.map((value, root) => ({
  value,
  root,
  label:
    (
      {
        'C#': 'C♯ / D♭',
        'D#': 'D♯ / E♭',
        'F#': 'F♯ / G♭',
        'G#': 'G♯ / A♭',
        'A#': 'A♯ / B♭',
      } as Record<string, string>
    )[value] ?? value,
}));

export interface PitchEstimate {
  frequency: number;
  /** 0..1; one means a strongly periodic signal. */
  clarity: number;
  /** Linear RMS of the analyzed input. */
  rms: number;
}

export interface HarmonySnapshot {
  active: boolean;
  detectedNote: string | null;
  pitchHz: number | null;
  pitchConfidence: number;
  /** Current major key, without the "major" suffix. */
  key: string;
  keyConfidence: number;
  keyOverride: string | null;
  chord: ChordName;
}

/**
 * YIN pitch detection over a mono time-domain buffer. It is intentionally
 * dependency-free so the live microphone path remains local and offline.
 */
export function detectPitch(
  samples: Float32Array,
  sampleRate: number,
  { minHz = 80, maxHz = 1000, threshold = 0.14, minRms = 0.012 } = {},
): PitchEstimate | null {
  if (samples.length < 32 || sampleRate <= 0) return null;

  let power = 0;
  for (const sample of samples) power += sample * sample;
  const rms = Math.sqrt(power / samples.length);
  if (rms < minRms) return null;

  const minLag = Math.max(2, Math.floor(sampleRate / maxHz));
  const maxLag = Math.min(Math.floor(sampleRate / minHz), Math.floor(samples.length / 2));
  if (minLag >= maxLag) return null;

  const difference = new Float32Array(maxLag + 1);
  for (let lag = 1; lag <= maxLag; lag++) {
    let sum = 0;
    const limit = samples.length - lag;
    for (let i = 0; i < limit; i++) {
      const delta = samples[i] - samples[i + lag];
      sum += delta * delta;
    }
    difference[lag] = sum;
  }

  let running = 0;
  difference[0] = 1;
  for (let lag = 1; lag <= maxLag; lag++) {
    running += difference[lag];
    difference[lag] = running === 0 ? 1 : (difference[lag] * lag) / running;
  }

  let lag = -1;
  for (let candidate = minLag; candidate <= maxLag; candidate++) {
    if (difference[candidate] >= threshold) continue;
    while (candidate < maxLag && difference[candidate + 1] < difference[candidate]) candidate++;
    lag = candidate;
    break;
  }
  if (lag < 0) return null;

  const left = difference[lag - 1] ?? difference[lag];
  const center = difference[lag];
  const right = difference[lag + 1] ?? center;
  const denominator = left + right - 2 * center;
  const refinedLag = denominator === 0 ? lag : lag + (left - right) / (2 * denominator);
  const frequency = sampleRate / refinedLag;
  const clarity = Math.max(0, Math.min(1, 1 - center));
  return Number.isFinite(frequency) ? { frequency, clarity, rms } : null;
}

export function noteFromFrequency(frequency: number): { midi: number; pitchClass: number; name: string } | null {
  if (!(frequency > 0)) return null;
  const midi = Math.round(69 + 12 * Math.log2(frequency / 440));
  if (!Number.isFinite(midi)) return null;
  const pitchClass = ((midi % 12) + 12) % 12;
  return { midi, pitchClass, name: `${NOTE_NAMES[pitchClass]}${Math.floor(midi / 12) - 1}` };
}

/**
 * Accumulates sung pitch classes, estimates a major key, and chooses one
 * diatonic chord per bar. It holds the previous chord when there is too little
 * voiced input, which is much less distracting than guessing through silence.
 */
export class SingingHarmonizer {
  private isActive = false;
  private overrideRoot: number | null = null;
  private autoRoot = DEFAULT_KEY_ROOT;
  private autoConfidence = 0;
  private pendingRoot = DEFAULT_KEY_ROOT;
  private pendingRootFrames = 0;
  private keySamples = 0;
  private readonly keyHistogram = new Float64Array(12);
  private readonly phraseHistogram = new Float64Array(12);
  private phraseSamples = 0;
  private stablePitchClass: number | null = null;
  private stablePitchFrames = 0;
  private lastVoicedAt = -Infinity;
  private note: string | null = null;
  private frequency: number | null = null;
  private confidence = 0;
  private degree = 0;
  private currentChord: ChordName = 'G';

  get active(): boolean {
    return this.isActive;
  }

  get chord(): ChordName {
    return this.currentChord;
  }

  setActive(active: boolean): void {
    if (active === this.isActive) return;
    this.isActive = active;
    this.resetEvidence();
    this.note = null;
    this.frequency = null;
    this.confidence = 0;
    this.degree = 0;
    this.currentChord = chordName(this.keyRoot, this.degree);
  }

  setKeyOverride(key: string | null): void {
    const root = key === null ? null : NOTE_NAMES.indexOf(key as (typeof NOTE_NAMES)[number]);
    this.overrideRoot = root !== null && root >= 0 ? root : null;
    this.degree = 0;
    this.phraseHistogram.fill(0);
    this.phraseSamples = 0;
    this.currentChord = chordName(this.keyRoot, this.degree);
  }

  observe(estimate: PitchEstimate, now = performance.now()): void {
    if (!this.isActive || estimate.clarity < 0.68) return this.observeSilence(now);
    const pitch = noteFromFrequency(estimate.frequency);
    if (!pitch) return this.observeSilence(now);

    this.note = pitch.name;
    this.frequency = estimate.frequency;
    this.confidence = estimate.clarity;
    this.lastVoicedAt = now;

    if (pitch.pitchClass === this.stablePitchClass) this.stablePitchFrames++;
    else {
      this.stablePitchClass = pitch.pitchClass;
      this.stablePitchFrames = 1;
    }
    // A two-frame vote rejects most octave-edge and consonant transients.
    if (this.stablePitchFrames < 2) return;

    for (let i = 0; i < 12; i++) this.keyHistogram[i] *= 0.998;
    const weight = estimate.clarity;
    this.keyHistogram[pitch.pitchClass] += weight;
    this.phraseHistogram[pitch.pitchClass] += weight;
    this.keySamples++;
    this.phraseSamples++;
    this.updateAutoKey();
  }

  observeSilence(now = performance.now()): void {
    if (now - this.lastVoicedAt < 280) return;
    this.note = null;
    this.frequency = null;
    this.confidence = 0;
    this.stablePitchClass = null;
    this.stablePitchFrames = 0;
  }

  /** Commit the harmony for the next bar and consume that bar's melody evidence. */
  chooseChord(): ChordName {
    if (this.phraseSamples < 2) {
      this.phraseHistogram.fill(0);
      this.phraseSamples = 0;
      return this.currentChord;
    }

    const root = this.keyRoot;
    const total = this.phraseHistogram.reduce((sum, value) => sum + value, 0);
    let bestDegree = this.degree;
    let bestScore = -Infinity;

    for (const candidate of CHORD_DEGREES) {
      const chordRoot = (root + MAJOR_SCALE[candidate]) % 12;
      const third = (chordRoot + (CHORD_QUALITIES[candidate] ? 3 : 4)) % 12;
      const fifth = (chordRoot + 7) % 12;
      const covered =
        this.phraseHistogram[chordRoot] +
        this.phraseHistogram[third] * 1.12 +
        this.phraseHistogram[fifth] * 0.92;
      const outside = Math.max(0, total - this.phraseHistogram[chordRoot] - this.phraseHistogram[third] - this.phraseHistogram[fifth]);
      const score =
        (covered - outside * 0.72) / Math.max(total, 0.001) +
        transitionScore(this.degree, candidate) +
        [0.18, 0, 0, 0.08, 0.1, 0.06][candidate];
      if (score > bestScore) {
        bestScore = score;
        bestDegree = candidate;
      }
    }

    this.degree = bestDegree;
    this.currentChord = chordName(root, bestDegree);
    this.phraseHistogram.fill(0);
    this.phraseSamples = 0;
    return this.currentChord;
  }

  snapshot(): HarmonySnapshot {
    return {
      active: this.isActive,
      detectedNote: this.note,
      pitchHz: this.frequency,
      pitchConfidence: this.confidence,
      key: NOTE_NAMES[this.keyRoot],
      keyConfidence: this.overrideRoot === null ? this.autoConfidence : 1,
      keyOverride: this.overrideRoot === null ? null : NOTE_NAMES[this.overrideRoot],
      chord: this.currentChord,
    };
  }

  private get keyRoot(): number {
    return this.overrideRoot ?? this.autoRoot;
  }

  private updateAutoKey(): void {
    if (this.overrideRoot !== null || this.keySamples < 18) return;
    let distinct = 0;
    for (const weight of this.keyHistogram) if (weight >= 1.25) distinct++;
    if (distinct < 3) return;

    const scores = NOTE_NAMES.map((_, tonic) =>
      MAJOR_PROFILE.reduce((sum, profileWeight, interval) => sum + profileWeight * this.keyHistogram[(tonic + interval) % 12], 0),
    );
    const ranked = scores.map((score, root) => ({ root, score })).sort((a, b) => b.score - a.score);
    const candidate = ranked[0].root;
    this.autoConfidence = Math.max(0, Math.min(1, ((ranked[0].score - ranked[1].score) / Math.max(ranked[0].score, 0.001)) * 5));
    if (candidate === this.pendingRoot) this.pendingRootFrames++;
    else {
      this.pendingRoot = candidate;
      this.pendingRootFrames = 1;
    }
    if (this.pendingRootFrames >= 5) this.autoRoot = candidate;
  }

  private resetEvidence(): void {
    this.keyHistogram.fill(0);
    this.phraseHistogram.fill(0);
    this.keySamples = 0;
    this.phraseSamples = 0;
    this.autoConfidence = 0;
    this.pendingRoot = this.autoRoot;
    this.pendingRootFrames = 0;
    this.stablePitchClass = null;
    this.stablePitchFrames = 0;
    this.lastVoicedAt = -Infinity;
  }
}

function chordName(keyRoot: number, degree: number): ChordName {
  const root = (keyRoot + MAJOR_SCALE[degree]) % 12;
  return `${NOTE_NAMES[root]}${CHORD_QUALITIES[degree] ? 'm' : ''}`;
}

function transitionScore(from: number, to: number): number {
  if (from === to) return 0.08;
  const preferred: Readonly<Record<number, readonly number[]>> = {
    0: [3, 4, 5, 1],
    1: [4, 0],
    2: [5, 3],
    3: [4, 0, 1],
    4: [0, 5],
    5: [3, 1, 4, 0],
  };
  const rank = preferred[from]?.indexOf(to) ?? -1;
  return rank < 0 ? -0.04 : 0.22 - rank * 0.035;
}
