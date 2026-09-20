import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '@/app/config';
import { fitAnchor, KitAnchorTracker, kitExtent, kitScale, placeKit, type AnchorSample } from '@/detectors/anchor';
import { FULL_FRAME } from '@/detectors/strumDetector';

const ASPECT = 4 / 3;
const DT = 1000 / 30;
const { layout } = DEFAULT_CONFIG.drum;
const opts = () => structuredClone(DEFAULT_CONFIG.drum.anchor);
const LEFT_HALF = { x0: 0, x1: 0.5 };
const RIGHT_HALF = { x0: 0.5, x1: 1 };

/** Two resting hands whose tips average (x, y). */
function hands(x: number, y: number, speed = 0, palmSize = 0.11): AnchorSample[] {
  return [
    { tip: { x: x - 0.12, y }, speed, palmSize },
    { tip: { x: x + 0.12, y }, speed, palmSize },
  ];
}

/** Feed the same samples for `ms`, from `t0`; returns the time of the last frame. */
function hold(tracker: KitAnchorTracker, samples: AnchorSample[], t0: number, ms: number): number {
  let t = t0;
  for (; t <= t0 + ms; t += DT) tracker.update(samples, t);
  return t - DT;
}

describe('kit layout', () => {
  it('is symmetric, touching and never overlapping, with pads named after samples', () => {
    expect(Object.keys(layout)).toEqual(['hihat', 'snare', 'tom1', 'crash']);
    expect(kitExtent(layout)).toEqual({ left: -4, right: 4, top: -2.6 });
    const pads = placeKit({ cx: 0.6, cy: 0.7, unit: 0.1 }, layout).sort((a, b) => a.x0 - b.x0);
    for (let i = 1; i < pads.length; i++) expect(pads[i].x0).toBeCloseTo(pads[i - 1].x1, 9);
    const snare = pads.find((p) => p.id === 'snare')!;
    expect(snare.y).toBeCloseTo(0.7, 9); // the anchor sits on the snare line
    expect(pads.find((p) => p.id === 'crash')!.y).toBeCloseTo(0.7 - 0.26, 9);
  });

  it('scales the h-unit thresholds with the kit, inside the clamp', () => {
    const o = opts();
    expect(kitScale(0.11, o)).toBe(1);
    expect(kitScale(0.077, o)).toBeCloseTo(0.7, 9);
    expect(kitScale(0.01, o)).toBe(o.scaleMin);
    expect(kitScale(0.5, o)).toBe(o.scaleMax);
  });
});

describe('fitAnchor', () => {
  const edges = (a: { cx: number; unit: number }) => ({ left: a.cx - 4 * a.unit, right: a.cx + 4 * a.unit });

  it('leaves a kit that already fits alone, snare line one unit under the hover height', () => {
    const a = fitAnchor({ cx: 0.66, hoverY: 0.55, unit: 0.11 }, layout, opts(), ASPECT, FULL_FRAME);
    expect(a).toEqual({ cx: 0.66, cy: 0.55 + 0.11, unit: 0.11 });
  });

  it('shrinks the unit, then moves the centre, so the whole kit stays inside a half frame', () => {
    const o = opts();
    for (const [region, cx] of [[LEFT_HALF, 1.2], [LEFT_HALF, -0.3], [RIGHT_HALF, 0.1], [RIGHT_HALF, 0.95]] as const) {
      const a = fitAnchor({ cx, hoverY: 0.55, unit: 0.11 }, layout, o, ASPECT, region);
      expect(a.unit * 8).toBeLessThanOrEqual(o.maxWidth * 0.5 * ASPECT + 1e-9);
      expect(edges(a).left).toBeGreaterThanOrEqual(region.x0 * ASPECT - 1e-9);
      expect(edges(a).right).toBeLessThanOrEqual(region.x1 * ASPECT + 1e-9);
    }
    // A centre that already fits is kept.
    expect(fitAnchor({ cx: 1.0, hoverY: 0.55, unit: 0.11 }, layout, o, ASPECT, RIGHT_HALF).cx).toBeCloseTo(1.0, 9);
  });

  it('keeps a lone player at the edge of the frame on screen', () => {
    const a = fitAnchor({ cx: 1.3, hoverY: 0.55, unit: 0.11 }, layout, opts(), ASPECT, FULL_FRAME);
    expect(edges(a).right).toBeCloseTo(ASPECT, 9);
    expect(a.unit).toBe(0.11);
  });

  it('never lifts a strike line off the top: high hands shrink the kit', () => {
    const o = opts();
    const a = fitAnchor({ cx: 0.66, hoverY: 0.1, unit: 0.11 }, layout, o, ASPECT, FULL_FRAME);
    expect(a.cy).toBe(o.cyMin);
    const top = Math.min(...placeKit(a, layout).map((p) => p.y));
    expect(top).toBeGreaterThanOrEqual(o.topMargin - 1e-9);
  });
});

describe('KitAnchorTracker', () => {
  it('sits at the default, centred in the region, until a player rests', () => {
    const tr = new KitAnchorTracker(opts);
    expect(tr.anchor(layout, ASPECT, FULL_FRAME)).toEqual({ cx: ASPECT / 2, cy: 0.68, unit: 0.11 });
    expect(tr.anchor(layout, ASPECT, RIGHT_HALF).cx).toBeCloseTo(0.75 * ASPECT, 9);
    hold(tr, hands(0.4, 0.5, 2), 0, 1000); // moving hands place nothing
    expect(tr.placed).toBe(false);
    expect(tr.state).toBe('auto');
  });

  it('lands on hands that rest for restMs, and then stays put: it does not wander', () => {
    const tr = new KitAnchorTracker(opts);
    let t = hold(tr, hands(0.5, 0.5), 0, 200);
    expect(tr.placed).toBe(false);
    t = hold(tr, hands(0.5, 0.5), t + DT, 100);
    expect(tr.state).toBe('locked');
    const landed = { cx: 0.5, cy: 0.61, unit: 0.11 };
    expect(tr.anchor(layout, ASPECT, FULL_FRAME)).toEqual(landed);

    // The player shuffles, rests somewhere else, comes closer: the kit is where it landed.
    hold(tr, hands(0.7, 0.4, 0, 0.14), t + DT, 5000);
    expect(tr.anchor(layout, ASPECT, FULL_FRAME)).toEqual(landed);
  });

  it('toggle: the kit follows the resting hands, the next toggle pins it exactly where it is', () => {
    const tr = new KitAnchorTracker(opts);
    let t = hold(tr, hands(0.5, 0.5), 0, 400);
    expect(tr.toggle()).toBe(true);
    expect(tr.state).toBe('auto');
    expect(tr.anchor(layout, ASPECT, FULL_FRAME).cx).toBe(0.5); // starting moves nothing

    // Fast hands are ignored; resting ones pull the kit over within a second, position, height and size.
    t = hold(tr, hands(0.8, 0.3, 2), t + DT, 500);
    expect(tr.anchor(layout, ASPECT, FULL_FRAME).cx).toBe(0.5);
    t = hold(tr, hands(0.8, 0.6, 0, 0.09), t + DT, 2000);
    const placed = tr.anchor(layout, ASPECT, FULL_FRAME);
    expect(placed.cx).toBeCloseTo(0.8, 2);
    expect(placed.cy).toBeCloseTo(0.69, 2);
    expect(placed.unit).toBeCloseTo(0.09, 3);

    expect(tr.toggle()).toBe(false);
    expect(tr.state).toBe('locked');
    expect(tr.anchor(layout, ASPECT, FULL_FRAME)).toEqual(placed); // no jump, no resize
    hold(tr, hands(0.5, 0.4, 0, 0.13), t + DT, 5000);
    expect(tr.anchor(layout, ASPECT, FULL_FRAME)).toEqual(placed); // and it never follows again

    tr.reset();
    expect(tr.state).toBe('auto');
    expect(tr.placed).toBe(false);
  });

  it('holds still for freezeMs after a hit while it is being placed', () => {
    const tr = new KitAnchorTracker(opts);
    let t = hold(tr, hands(0.5, 0.5), 0, 400);
    tr.toggle();
    tr.noteHit(t);
    t = hold(tr, hands(0.8, 0.5), t + DT, 250);
    expect(tr.anchor(layout, ASPECT, FULL_FRAME).cx).toBe(0.5);
    hold(tr, hands(0.8, 0.5), t + DT, 500);
    expect(tr.anchor(layout, ASPECT, FULL_FRAME).cx).toBeGreaterThan(0.5);
  });

  it('lands again on the next visitor after lostMs without hands, unless the player pinned it', () => {
    const auto = new KitAnchorTracker(opts);
    let t = hold(auto, hands(0.4, 0.5), 0, 400);
    t = hold(auto, [], t + DT, 2500);
    hold(auto, hands(0.8, 0.5), t + DT, 400);
    expect(auto.anchor(layout, ASPECT, FULL_FRAME).cx).toBeCloseTo(0.8, 9);

    const pinned = new KitAnchorTracker(opts);
    t = hold(pinned, hands(0.5, 0.5), 0, 400);
    pinned.toggle();
    pinned.toggle();
    t = hold(pinned, [], t + DT, 2500);
    hold(pinned, hands(0.8, 0.5), t + DT, 400);
    expect(pinned.anchor(layout, ASPECT, FULL_FRAME).cx).toBe(0.5);
  });

  it('survives the clock going back (a replay restarting)', () => {
    const tr = new KitAnchorTracker(opts);
    const t = hold(tr, hands(0.5, 0.5), 5000, 400);
    tr.toggle();
    tr.noteHit(t);
    hold(tr, hands(0.8, 0.5), 0, 1500);
    expect(tr.anchor(layout, ASPECT, FULL_FRAME).cx).toBeGreaterThan(0.55);
  });
});
