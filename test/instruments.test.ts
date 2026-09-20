import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '@/app/config';
import { createInstrument, INSTRUMENT_IDS, INSTRUMENT_MODES } from '@/app/instruments';
import type { ToneAudioNode } from 'tone';
import type { Vec2, VisionFrame } from '@/core/types';
import { DrumsFx, GuitarFx } from '@/render/fx';
import { handAt } from './helpers/hands';

const deps = () => ({ config: structuredClone(DEFAULT_CONFIG), output: () => ({}) as ToneAudioNode });

/** Canvas stand-in that records the rectangles stroked and the ellipses drawn on it. */
function fakeCtx() {
  const rects: number[][] = [];
  const ellipses: number[][] = [];
  const record: Record<string, number[][]> = { strokeRect: rects, ellipse: ellipses };
  const ctx = new Proxy({} as Record<string, unknown>, {
    get: (target, prop) => (record[prop as string] ? (...a: number[]) => record[prop as string].push(a) : (target[prop as string] ?? (() => {}))),
    set: (target, prop, value) => ((target[prop as string] = value), true),
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, rects, ellipses };
}

describe('instrument registry', () => {
  it('every pickable instrument builds and lists its modes', () => {
    for (const id of INSTRUMENT_IDS) {
      const inst = createInstrument(id, deps());
      expect(inst.id).toBe(id);
      expect(inst.view?.()?.instrument).toBe(id);
      expect(INSTRUMENT_MODES[id]).toContain('easy');
      inst.dispose?.();
    }
    expect(INSTRUMENT_MODES.guitar).toEqual(['easy']);
  });

  it('guitar uses its registered compact overlay at the frame aspect', () => {
    const d = deps();
    const guitar = createInstrument('guitar', d);
    const frame: VisionFrame = { t: 0, aspect: 16 / 9, hands: [], inferenceMs: 0 };
    expect(guitar.detectors[0].update(frame)).toEqual([]);
    expect(guitar.overlay).toBeInstanceOf(GuitarFx);

    const { ctx } = fakeCtx();
    const toPx = (v: Vec2): Vec2 => ({ x: v.x * 100, y: v.y * 100 });
    expect(() => guitar.overlay.draw(ctx, frame, toPx)).not.toThrow();
  });

  it("each drummer's overlay draws that drummer's placed kit, through Alex's unchanged DrumsFx", () => {
    const d = deps();
    const half = (x0: number, x1: number) => () => ({ x0, x1 });
    const p0 = createInstrument('drums', { ...d, playerId: 0, region: half(0, 0.5) });
    const p1 = createInstrument('drums', { ...d, playerId: 1, region: half(0.5, 1) });
    expect((p0.overlay as unknown as { art: unknown }).art).toBeInstanceOf(DrumsFx);
    expect(p0.view?.()).toMatchObject({ instrument: 'drums', calibration: 'locked' }); // the default kit stays put

    const ASPECT = 4 / 3;
    const frame: VisionFrame = { t: 0, aspect: ASPECT, hands: [handAt(1, { x: 0.3, y: 0.5 }, 0, 0), handAt(2, { x: 1.0, y: 0.4 }, 0, 0, { playerId: 1 })], inferenceMs: 0 };
    // C, rest, C: each kit follows its own player's hand, then is pinned.
    expect(p0.calibrate?.(frame)).toBe(true);
    expect(p1.calibrate?.(frame)).toBe(true);
    expect(p0.view?.()).toMatchObject({ calibration: 'auto' });
    for (let t = 33; t < 1500; t += 33) for (const inst of [p0, p1]) inst.detectors[0].update({ ...frame, t, hands: frame.hands.map((h) => ({ ...h, t, dt: 33 })) });
    expect(p0.calibrate?.(frame)).toBe(true);
    expect(p1.calibrate?.(frame)).toBe(true);
    const toPx = (v: Vec2): Vec2 => ({ x: v.x * 100, y: v.y * 100 });
    for (const inst of [p0, p1]) {
      const view = inst.view?.();
      if (view?.instrument !== 'drums') throw new Error('no drums view');
      expect(view.calibration).toBe('locked');
      const { ctx, ellipses } = fakeCtx();
      inst.overlay.draw(ctx, { ...frame, hands: [] }, toPx);
      // One ellipse per pad, centred on the detector's pads and as tall as the scaled pad.
      expect(ellipses.map((e) => [e[0], e[1]])).toEqual(view.pads.map((p) => [expect.closeTo(((p.x0 + p.x1) / 2) * 100, 6), expect.closeTo(p.y * 100, 6)]));
      const scale = view.anchor!.unit / d.config.drum.anchor.defaultUnit;
      expect(ellipses[0][3]).toBeCloseTo(d.config.drum.padHalfHeight * scale * 100, 6);
    }
    const xs = (inst: typeof p0) => (inst.view?.() as { pads: { x0: number; x1: number }[] }).pads;
    expect(Math.max(...xs(p0).map((p) => p.x1))).toBeLessThanOrEqual(ASPECT / 2 + 1e-9);
    expect(Math.min(...xs(p1).map((p) => p.x0))).toBeGreaterThanOrEqual(ASPECT / 2 - 1e-9);
    // The shared config is untouched: the fixed kit is still there for ?drum.bodyRelative=false.
    expect(d.config.drum.kit).toEqual(DEFAULT_CONFIG.drum.kit);
    expect(d.config.drum.padHalfHeight).toBe(DEFAULT_CONFIG.drum.padHalfHeight);

    p0.resetCalibration?.();
    expect((p0.view?.() as { anchor: { cx: number } }).anchor.cx).toBeCloseTo(ASPECT / 4, 9); // back to the middle of their half
    p0.dispose?.();
    p1.dispose?.();
  });
});
