import { describe, expect, it } from 'vitest';
import { EasyMode, FREEPLAY_CONTEXT, HardMode, createResolver } from '@/audio/modes';
import { grooveRole, isAutoKickBeat, positionAt } from '@/audio/groove';
import type { DrumHitEvent, SongContext } from '@/core/types';
import { voicingFor } from '@/song/chords';
import { SONGS, getSong } from '@/song/songs';
import { barCount, chordAtBar, flattenBars, parseSong } from '@/song/types';

describe('song schema and lookups', () => {
  it('built-in songs validate and every chart chord can be played', () => {
    for (const song of Object.values(SONGS)) {
      expect(() => parseSong(song)).not.toThrow();
      for (const bar of flattenBars(song)) expect(voicingFor(bar.chord), `${song.title}: ${bar.chord}`).not.toBeNull();
    }
    expect(getSong('nope').title).toBe(getSong('viva-la-vida').title);
  });

  it('rejects malformed charts', () => {
    expect(() => parseSong({ title: 'x', bpm: 0, key: 'G', timeSig: [4, 4], sections: [] })).toThrow();
    expect(() => parseSong({ title: '', bpm: 100, key: 'G', timeSig: [4, 4], sections: [{ name: 'a', bars: [] }] })).toThrow();
    expect(() => parseSong({ title: 'x', bpm: 100, key: 'G', timeSig: [4], sections: [{ name: 'a', bars: [{ chord: 'G' }] }] })).toThrow();
  });

  it('stores transposed starting vocal cues in concert pitch', () => {
    expect(getSong('viva-la-vida').vocalCue).toEqual({ pitch: 'B3', lyric: 'I used to…', chord: 'Em' });
    expect(getSong('counting-stars').vocalCue).toEqual({ pitch: 'A3', lyric: 'Lately, I’ve been…', chord: 'Em' });
    expect(getSong('stand-by-me').vocalCue).toEqual({ pitch: 'B3', lyric: 'When the night…', chord: 'G' });
  });

  it('flattens sections in order and loops the chord lookup', () => {
    const song = getSong('counting-stars');
    expect(barCount(song)).toBe(8);
    expect(flattenBars(song).map((b) => b.chord)).toEqual(['Em', 'G', 'D', 'C', 'Em', 'G', 'D', 'C']);
    expect(flattenBars(song)[4].section).toBe('chorus');
    expect(chordAtBar(song, 0)).toBe('Em');
    expect(chordAtBar(song, 6)).toBe('D');
    expect(chordAtBar(song, 8)).toBe('Em'); // wraps
    expect(chordAtBar(song, 11)).toBe('C');
    expect(chordAtBar(song, -3)).toBe('Em');
  });
});

describe('beat grid', () => {
  it('converts seconds to bar / beat / phase', () => {
    expect(positionAt(0, 120, 4)).toMatchObject({ bar: 0, beat: 0, beatPhase: 0 });
    expect(positionAt(2.5, 120, 4)).toMatchObject({ bar: 1, beat: 1 }); // 5 beats in
    const p = positionAt(0.3, 120, 4); // 0.6 of a beat
    expect(p.bar).toBe(0);
    expect(p.beat).toBe(0);
    expect(p.beatPhase).toBeCloseTo(0.6, 6);
    expect(positionAt(-1, 120, 4).beatsTotal).toBe(0);
  });

  it('beat-role table: kick on 1 and 3, snare on 2 and 4, hi-hat on the ands, crash closing bar 4', () => {
    const roles = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5].map((b) => grooveRole(b, 4, 0));
    expect(roles).toEqual(['kick', 'hihat', 'snare', 'hihat', 'kick', 'hihat', 'snare', 'hihat']);
    expect(grooveRole(3, 4, 3)).toBe('crash');
    expect(grooveRole(2.9, 4, 7)).toBe('crash'); // rounds onto beat 4 of bar 8
    expect(grooveRole(3, 4, 2)).toBe('snare');
    // Late in the last beat rounds to beat 1 of the next bar: a kick, never a crash.
    expect(grooveRole(3.8, 4, 3)).toBe('kick');
    expect(grooveRole(0.2, 4, 1)).toBe('kick');
    expect(grooveRole(0.3, 4, 1)).toBe('hihat');
    expect([0, 1, 2, 3].map(isAutoKickBeat)).toEqual([true, false, true, false]);
  });
});

describe('note resolvers', () => {
  const hit = (pad: string, velocity = 0.7): DrumHitEvent => ({ type: 'drum.hit', t: 0, playerId: 0, pad, velocity });
  const song = (beat: number, beatPhase: number, bar = 0): SongContext => ({
    bpm: 120,
    beatsPerBar: 4,
    bar,
    beat,
    beatPhase,
    chord: 'G',
    key: 'G',
  });

  it('hard mode plays the pad that was struck', () => {
    expect(new HardMode().resolveDrum(hit('tom1', 0.5), song(1, 0.5))).toEqual({ sample: 'tom1', velocity: 0.5 });
  });

  it('easy mode plays the groove drum for the beat position, keeping the velocity', () => {
    const easy = new EasyMode();
    expect(easy.resolveDrum(hit('tom1'), song(0, 0.1))).toEqual({ sample: 'kick', velocity: 0.7 });
    expect(easy.resolveDrum(hit('tom1'), song(1, 0.0))).toEqual({ sample: 'snare', velocity: 0.7 });
    expect(easy.resolveDrum(hit('crash'), song(2, 0.5))).toEqual({ sample: 'hihat', velocity: 0.7 });
    expect(easy.resolveDrum(hit('hihat'), song(3, 0.05, 3))).toEqual({ sample: 'crash', velocity: 0.7 });
  });

  it('easy mode keeps the kick pad as a kick and falls back to the pad with no song', () => {
    const easy = new EasyMode();
    expect(easy.resolveDrum(hit('kick', 0.9), song(1, 0)).sample).toBe('kick');
    expect(easy.resolveDrum(hit('tom2'), FREEPLAY_CONTEXT).sample).toBe('tom2');
  });

  it('createResolver picks by mode id', () => {
    expect(createResolver('easy').id).toBe('easy');
    expect(createResolver('hard').id).toBe('hard');
  });
});
