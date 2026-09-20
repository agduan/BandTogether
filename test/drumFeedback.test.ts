import { describe, expect, it } from 'vitest';
import type { ToneAudioNode } from 'tone';
import { DEFAULT_CONFIG } from '@/app/config';
import { createInstrument } from '@/app/instruments';
import { absoluteSlot, isInTime, KickCover, nearestSlot } from '@/audio/groove';
import { EasyMode, FREEPLAY_CONTEXT, HardMode } from '@/audio/modes';
import { bus } from '@/core/bus';
import type { DrumHitEvent, PlayMode, SongContext, Vec2, VisionFrame } from '@/core/types';
import { DrumFeedbackOverlay, judgeHit } from '@/detectors/drumFeedback';

const song = (beat: number, beatPhase: number, bar = 0, extra: Partial<SongContext> = {}): SongContext => ({ bpm: 120, beatsPerBar: 4, bar, beat, beatPhase, chord: 'G', key: 'G', ...extra });
const hit = (pad: string, playerId: 0 | 1 = 0, t = 0): DrumHitEvent => ({ type: 'drum.hit', t, playerId, pad, velocity: 0.7 });
const feedback = DEFAULT_CONFIG.drum.feedback;

describe('eighth-note grid', () => {
  it('finds the nearest slot and how far off a hit is', () => {
    expect(nearestSlot(1)).toEqual({ slot: 2, offset: 0 });
    expect(nearestSlot(1.1).slot).toBe(2);
    expect(nearestSlot(1.1).offset).toBeCloseTo(0.2, 9);
    expect(nearestSlot(3.95).slot).toBe(8); // rounds into the next bar
    expect(nearestSlot(3.95).offset).toBeCloseTo(-0.1, 9);
  });

  it('in time = within the window of an eighth, on beats and on the "and"s alike', () => {
    expect(isInTime(2, 0.3)).toBe(true);
    expect(isInTime(2.5, 0.3)).toBe(true);
    expect(isInTime(2.14, 0.3)).toBe(true);
    expect(isInTime(2.25, 0.3)).toBe(false); // a sixteenth: as far from the grid as a hit can be
    expect(isInTime(2.25, 0.5)).toBe(true);
  });

  it('counts slots from bar 0, and only the last slot of the count-in belongs to the chart', () => {
    expect(absoluteSlot(song(2, 0.1, 3))).toBe(3 * 8 + 4);
    expect(absoluteSlot(song(3, 0.9, 3))).toBe(4 * 8);
    expect(absoluteSlot(song(1, 0, 0, { countIn: true }))).toBeNull();
    expect(absoluteSlot(song(3, 0.9, 0, { countIn: true }))).toBe(0);
  });
});

describe('auto kick steps aside for the player', () => {
  it('skips the beat the player just claimed, and the next kick beat after a late one', () => {
    const cover = new KickCover();
    expect(cover.covers(0, 0, 4)).toBe(false);
    cover.notePlayerKick(song(1, 0.9, 0)); // just before beat 3 of bar 0
    expect(cover.covers(0, 2, 4)).toBe(true); // that kick is theirs
    expect(cover.covers(1, 0, 4)).toBe(true); // they are covering the kicks: the next one too
    expect(cover.covers(1, 2, 4)).toBe(false); // they stopped: one kick missed, then the auto kick is back
    cover.notePlayerKick(song(2, 0.1, 1)); // late on beat 3 of bar 1, after the auto kick sounded
    expect(cover.covers(2, 0, 4)).toBe(true);
    cover.reset();
    expect(cover.covers(2, 0, 4)).toBe(false);
  });

  it('only kicks on 1 and 3 count, and nothing in the count-in except the pickup into bar 0', () => {
    const cover = new KickCover();
    cover.notePlayerKick(song(1, 0, 0)); // spacebar on beat 2
    cover.notePlayerKick(song(0, 0.5, 0)); // an "and"
    cover.notePlayerKick(song(2, 0, 0, { countIn: true }));
    expect(cover.covers(0, 2, 4)).toBe(false);
    cover.notePlayerKick(song(3, 0.95, 0, { countIn: true }));
    expect(cover.covers(0, 0, 4)).toBe(true);
  });

  it('easy mode reports the kicks it sounds; hard mode and free play report none', () => {
    const cover = new KickCover();
    const easy = new EasyMode(cover);
    expect(easy.resolveDrum(hit('tom1'), song(1, 0, 0)).sample).toBe('snare');
    expect(cover.covers(0, 2, 4)).toBe(false);
    expect(easy.resolveDrum(hit('tom1'), song(2, 0.05, 0)).sample).toBe('kick');
    expect(cover.covers(1, 0, 4)).toBe(true);
    const none = new KickCover();
    new EasyMode(none).resolveDrum(hit('kick'), FREEPLAY_CONTEXT);
    new HardMode().resolveDrum(hit('kick'), song(0, 0));
    expect(none.covers(0, 0, 4)).toBe(false);
  });
});

describe('drum hit feedback', () => {
  it('judges timing in easy mode while a song runs, and nothing else by default', () => {
    expect(judgeHit(song(1, 0.05), 'easy', feedback)).toBe('good');
    expect(judgeHit(song(1, 0.55), 'easy', feedback)).toBe('good');
    expect(judgeHit(song(1, 0.25), 'easy', feedback)).toBe('bad');
    expect(judgeHit(FREEPLAY_CONTEXT, 'easy', feedback)).toBeNull();
    expect(judgeHit(song(1, 0.25), 'hard', feedback)).toBeNull();
    expect(judgeHit(song(1, 0.25), 'hard', { ...feedback, hardMode: true })).toBe('bad');
    expect(judgeHit(song(1, 0), 'easy', { ...feedback, enabled: false })).toBeNull();
  });

  function recorder() {
    const calls: { op: string; args: unknown[]; stroke?: unknown }[] = [];
    const state: Record<string, unknown> = {};
    const ctx = new Proxy(state, {
      get: (target, prop) =>
        prop in target ? target[prop as string] : (...args: unknown[]) => (calls.push({ op: prop as string, args, stroke: state.strokeStyle }), prop === 'measureText' ? { width: 100 } : undefined),
      set: (target, prop, value) => ((target[prop as string] = value), true),
    });
    return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
  }
  const toPx = (v: Vec2): Vec2 => ({ x: v.x * 100, y: v.y * 100 });
  const frame = (t: number): VisionFrame => ({ t, aspect: 4 / 3, hands: [], inferenceMs: 0 });

  it("outlines only that player's half, green or red, and fades out", () => {
    let now = song(1, 0.02);
    let mode: PlayMode = 'easy';
    const overlay = new DrumFeedbackOverlay({
      config: structuredClone(DEFAULT_CONFIG),
      playerId: 1,
      song: () => now,
      mode: () => mode,
      region: () => ({ x0: 0.5, x1: 1 }),
      pads: () => [{ id: 'snare', x0: 0.9, x1: 1.1, y: 0.68 }],
      padHalfHeight: () => 0.06,
    });
    bus.emit(hit('snare', 0, 1000)); // the other player's hit
    expect(overlay.lastVerdict).toBeNull();
    bus.emit(hit('snare', 1, 1000));
    expect(overlay.lastVerdict).toBe('good');

    const outline = (t: number) => {
      const { ctx, calls } = recorder();
      overlay.draw(ctx, frame(t), toPx);
      const i = calls.findIndex((c) => c.op === 'stroke');
      return i < 0 ? null : { rect: calls.slice(0, i).reverse().find((c) => c.op === 'roundRect')!.args as number[], color: calls[i].stroke };
    };
    const green = outline(1050)!;
    expect(green.color).toBe('#3dff8a');
    expect(green.rect[0]).toBeGreaterThanOrEqual((4 / 3) * 50); // starts at the middle of the frame
    expect(green.rect[0] + green.rect[2]).toBeLessThanOrEqual((4 / 3) * 100);
    expect(outline(1000 + feedback.flashMs + 1)).toBeNull();

    now = song(1, 0.25);
    bus.emit(hit('snare', 1, 2000));
    expect(outline(2050)!.color).toBe('#ff4d5e');

    mode = 'hard';
    bus.emit(hit('snare', 1, 3000));
    expect(outline(3050)).toBeNull(); // hard mode is not judged: the red one has faded, no new one
    overlay.dispose();
    now = song(1, 0);
    mode = 'easy';
    bus.emit(hit('snare', 1, 4000));
    expect(outline(4050)).toBeNull();
  });

  it('the kit art lights the drum that sounded in easy mode, and the struck pad in hard mode', () => {
    let now = song(1, 0); // beat 2: the groove wants the snare
    let mode: PlayMode = 'easy';
    const drums = createInstrument('drums', { config: structuredClone(DEFAULT_CONFIG), output: () => ({}) as ToneAudioNode, song: () => now, mode: () => mode });
    const art = (drums.overlay as unknown as { art: { flashes: Map<string, unknown> } }).art;
    drums.overlay.draw(recorder().ctx, frame(0), toPx);
    bus.emit(hit('crash'));
    expect([...art.flashes.keys()]).toEqual(['snare']);
    now = song(2, 0); // beat 3: the kick, which the four-pad kit has no pad for
    bus.emit(hit('crash', 0, 10));
    expect([...art.flashes.keys()]).toEqual(['snare']);
    const { ctx, calls } = recorder();
    drums.overlay.draw(ctx, frame(20), toPx);
    expect(calls.some((c) => c.op === 'fillText' && c.args[0] === 'kick')).toBe(true);
    mode = 'hard';
    bus.emit(hit('crash', 0, 30));
    expect([...art.flashes.keys()]).toEqual(['snare', 'crash']);
    drums.dispose?.();
  });
});
