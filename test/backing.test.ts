import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '@/app/config';
import { BASS_LOWEST, PAD_LOWEST, partPlayedBy, planStep, type BackingNote } from '@/audio/backing';
import { positionWithCountIn, stepAt } from '@/audio/groove';
import { FREEPLAY_CONTEXT } from '@/audio/modes';
import { judgeNow } from '@/audio/score';
import { chordTones, midiToNote } from '@/song/chords';

describe('count-in grid', () => {
  it('counts one bar of beats before bar 0', () => {
    // 120 bpm = 0.5 s a beat; a four-beat count-in is 2 s.
    expect(positionWithCountIn(0, 120, 4, 4)).toMatchObject({ countIn: true, bar: 0, beat: 0, beatPhase: 0 });
    const p = positionWithCountIn(1.75, 120, 4, 4);
    expect(p).toMatchObject({ countIn: true, bar: 0, beat: 3 });
    expect(p.beatPhase).toBeCloseTo(0.5);
    expect(positionWithCountIn(2, 120, 4, 4)).toMatchObject({ countIn: false, bar: 0, beat: 0 });
    expect(positionWithCountIn(2 + 2.5, 120, 4, 4)).toMatchObject({ countIn: false, bar: 1, beat: 1 });
  });

  it('beatPhase runs straight through the end of the count-in', () => {
    const before = positionWithCountIn(1.99, 120, 4, 4);
    const after = positionWithCountIn(2.01, 120, 4, 4);
    expect(before.beatPhase).toBeCloseTo(0.98);
    expect(after.beatPhase).toBeCloseTo(0.02);
  });

  it('no count-in is the plain grid', () => {
    expect(positionWithCountIn(2.5, 120, 4, 0)).toMatchObject({ countIn: false, bar: 1, beat: 1 });
  });

  it('stepAt walks eighths: count-in first, then the chart from bar 0', () => {
    expect(stepAt(0, 4, 4)).toEqual({ bar: 0, beat: 0, sub: 0, countIn: true });
    expect(stepAt(7, 4, 4)).toEqual({ bar: 0, beat: 3, sub: 1, countIn: true });
    expect(stepAt(8, 4, 4)).toEqual({ bar: 0, beat: 0, sub: 0, countIn: false });
    expect(stepAt(8 + 8 + 3, 4, 4)).toEqual({ bar: 1, beat: 1, sub: 1, countIn: false });
    expect(stepAt(6, 3, 3)).toEqual({ bar: 0, beat: 0, sub: 0, countIn: false });
  });

  it('nothing is judged during the count-in', () => {
    const ctx = { ...FREEPLAY_CONTEXT, bpm: 120, beatPhase: 0 };
    expect(judgeNow(ctx, DEFAULT_CONFIG.score)?.judgement).toBe('perfect');
    expect(judgeNow({ ...ctx, countIn: true }, DEFAULT_CONFIG.score)).toBeNull();
  });
});

describe('chordTones', () => {
  it('puts the root at or above the floor and stacks the triad on it', () => {
    expect(chordTones('G', BASS_LOWEST)).toEqual({ root: 43, third: 47, fifth: 50 }); // G2
    expect(chordTones('C', BASS_LOWEST)).toEqual({ root: 36, third: 40, fifth: 43 }); // C2 is the floor itself
    expect(chordTones('Em', PAD_LOWEST)).toEqual({ root: 52, third: 55, fifth: 59 }); // E3 G3 B3
    expect(chordTones('F#m7', PAD_LOWEST)).toMatchObject({ root: 54, third: 57 });
    expect(chordTones('Bb', 36)?.root).toBe(46);
    expect(chordTones('???', 36)).toBeNull();
  });
});

describe('planStep', () => {
  const at = (bar: number, beat: number, sub: 0 | 1, chord = 'G', countIn = false) => ({ bar, beat, sub, countIn, beatsPerBar: 4, chord });
  const parts = (notes: BackingNote[], part: string) => notes.filter((n) => n.part === part);

  it('is silent during the count-in', () => {
    expect(planStep(at(0, 2, 0, 'G', true), false)).toEqual([]);
  });

  it('drums: kick on 1 and 3, snare on 2 and 4, hats on every eighth, a crash at the top of the chart', () => {
    const samples = (bar: number, beat: number, sub: 0 | 1) =>
      parts(planStep(at(bar, beat, sub), true), 'drums')
        .map((n) => n.sample)
        .sort();
    expect(samples(0, 0, 0)).toEqual(['crash', 'hihat', 'kick']);
    expect(samples(1, 0, 0)).toEqual(['hihat', 'kick']);
    expect(samples(1, 1, 0)).toEqual(['hihat', 'snare']);
    expect(samples(1, 2, 0)).toEqual(['hihat', 'kick']);
    expect(samples(1, 3, 0)).toEqual(['hihat', 'snare']);
    expect(samples(1, 3, 1)).toEqual(['hihat']);
    expect(samples(8, 0, 0)).toContain('crash');
  });

  it('bass: root on 1, the fifth on 3, always inside the chord', () => {
    const bass = (beat: number, sub: 0 | 1, chord: string) => parts(planStep(at(2, beat, sub, chord), true), 'bass')[0]?.notes?.[0];
    expect(bass(0, 0, 'G')).toBe('G2');
    expect(bass(2, 0, 'G')).toBe('D3');
    expect(bass(3, 0, 'G')).toBe('G2');
    expect(bass(0, 0, 'Em')).toBe('E2');
    expect(bass(2, 0, 'Em')).toBe('B2');
    expect(bass(0, 1, 'G')).toBeUndefined();
  });

  it('pad: the triad of the bar, held to the bar line; comes back mid-bar only when it is not sounding', () => {
    const pad = parts(planStep(at(3, 0, 0, 'D'), true), 'pad')[0];
    expect(pad.notes).toEqual(['D4', 'F#4', 'A4']);
    expect(pad.steps).toBe(8);
    expect(parts(planStep(at(3, 2, 0, 'D'), true), 'pad')).toHaveLength(0);
    const back = parts(planStep(at(3, 2, 0, 'D'), false), 'pad')[0];
    expect(back.steps).toBe(4);
    expect(parts(planStep(at(3, 2, 1, 'D'), false), 'pad')).toHaveLength(0); // never on an off-beat
  });

  it('an unparseable chord keeps the drums and drops the pitched parts', () => {
    const notes = planStep(at(1, 0, 0, '???'), false);
    expect(parts(notes, 'drums').length).toBeGreaterThan(0);
    expect(parts(notes, 'bass')).toHaveLength(0);
    expect(parts(notes, 'pad')).toHaveLength(0);
  });

  it('every pitched note is a real note name', () => {
    for (const chord of ['G', 'C', 'D', 'Em']) {
      for (let beat = 0; beat < 4; beat++) {
        for (const sub of [0, 1] as const) {
          for (const n of planStep(at(0, beat, sub, chord), false)) {
            for (const note of n.notes ?? []) expect(note).toMatch(/^[A-G]#?\d$/);
          }
        }
      }
    }
    expect(midiToNote(BASS_LOWEST)).toBe('C2');
    expect(midiToNote(PAD_LOWEST)).toBe('E3');
  });
});

describe('partPlayedBy', () => {
  it('maps each instrument to the backing part it replaces', () => {
    expect(partPlayedBy('drums')).toBe('drums');
    expect(partPlayedBy('bass')).toBe('bass');
    expect(partPlayedBy('guitar')).toBe('pad');
    expect(partPlayedBy('keyboard')).toBeNull();
  });
});
