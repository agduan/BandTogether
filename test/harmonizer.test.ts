import { describe, expect, it } from 'vitest';
import { detectPitch, noteFromFrequency, SingingHarmonizer } from '@/audio/harmonizer';

function sine(frequency: number, sampleRate = 48_000, length = 4096): Float32Array {
  return Float32Array.from({ length }, (_, i) => Math.sin((2 * Math.PI * frequency * i) / sampleRate) * 0.5);
}

function sing(harmonizer: SingingHarmonizer, frequencies: number[]): void {
  let t = 0;
  for (const frequency of frequencies) {
    // Two frames establish the note; extra frames represent its duration.
    for (let frame = 0; frame < 5; frame++) {
      harmonizer.observe({ frequency, clarity: 0.95, rms: 0.3 }, (t += 50));
    }
  }
}

describe('microphone pitch analysis', () => {
  it('finds a sung sine pitch and rejects silence', () => {
    const estimate = detectPitch(sine(440), 48_000);
    expect(estimate?.frequency).toBeCloseTo(440, 0);
    expect(estimate?.clarity).toBeGreaterThan(0.9);
    expect(detectPitch(new Float32Array(4096), 48_000)).toBeNull();
  });

  it('turns frequency into a concert-pitch note name', () => {
    expect(noteFromFrequency(440)).toEqual({ midi: 69, pitchClass: 9, name: 'A4' });
    expect(noteFromFrequency(261.63)?.name).toBe('C4');
  });
});

describe('singing harmonizer', () => {
  it('chooses the C chord for a C major triad', () => {
    const harmonizer = new SingingHarmonizer();
    harmonizer.setKeyOverride('C');
    harmonizer.setActive(true);
    sing(harmonizer, [261.63, 329.63, 392]);
    expect(harmonizer.chooseChord()).toBe('C');
    expect(harmonizer.snapshot()).toMatchObject({ key: 'C', keyOverride: 'C', chord: 'C' });
  });

  it('chooses A minor for A-C-E and holds it through an empty bar', () => {
    const harmonizer = new SingingHarmonizer();
    harmonizer.setKeyOverride('C');
    harmonizer.setActive(true);
    sing(harmonizer, [220, 261.63, 329.63]);
    expect(harmonizer.chooseChord()).toBe('Am');
    expect(harmonizer.chooseChord()).toBe('Am');
  });

  it('holds the last detected note briefly through consonants, then clears it', () => {
    const harmonizer = new SingingHarmonizer();
    harmonizer.setActive(true);
    harmonizer.observe({ frequency: 440, clarity: 0.95, rms: 0.3 }, 100);
    harmonizer.observeSilence(300);
    expect(harmonizer.snapshot().detectedNote).toBe('A4');
    harmonizer.observeSilence(500);
    expect(harmonizer.snapshot().detectedNote).toBeNull();
  });
});
