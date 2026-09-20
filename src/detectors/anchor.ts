import type { Config, KitPadOffset } from '@/app/config';
import type { Vec2 } from '@/core/types';
import type { KitAnchor, PadGeometry } from '@/core/views';
import { clamp } from './detector';
import type { PlayerRegion } from './strumDetector';

export type AnchorOptions = Config['drum']['anchor'];
export type KitLayout = Record<string, KitPadOffset>;

/** One hand of the drummer, as the anchor sees it. */
export interface AnchorSample {
  /** Strike point (stick tip or palm), display space. */
  tip: Vec2;
  /** Hand speed, h/s. */
  speed: number;
  palmSize: number;
}

/** Where the player is: kit centre, the height their sticks hover at, and their palm size. Not yet fitted to the screen. */
export interface KitPose {
  cx: number;
  hoverY: number;
  unit: number;
}

/** Smallest unit a kit is ever drawn at (h); keeps a degenerate region or pose from collapsing it. */
const MIN_UNIT = 0.03;

/** Outline of a layout in palm units: leftmost and rightmost pad edges, and the highest strike line. */
export function kitExtent(layout: KitLayout): { left: number; right: number; top: number } {
  const pads = Object.values(layout);
  if (pads.length === 0) return { left: 0, right: 0, top: 0 };
  return {
    left: Math.min(...pads.map((p) => p.dx - p.halfWidth)),
    right: Math.max(...pads.map((p) => p.dx + p.halfWidth)),
    top: Math.min(...pads.map((p) => p.dy)),
  };
}

/**
 * Fit a pose to the player's slice of the screen. The unit shrinks first, so
 * the kit is never wider than `maxWidth` of the region nor taller than the
 * space above the snare line; then the centre moves, so the outermost pad
 * edges stay inside the region. The snare line sits one unit under the hover
 * height: resting sticks are just above it.
 */
export function fitAnchor(pose: KitPose, layout: KitLayout, opts: AnchorOptions, aspect: number, region: PlayerRegion): KitAnchor {
  const ext = kitExtent(layout);
  const x0 = region.x0 * aspect;
  const x1 = region.x1 * aspect;
  const widthUnits = Math.max(1e-6, ext.right - ext.left);
  let unit = Math.min(pose.unit, (opts.maxWidth * (x1 - x0)) / widthUnits);
  const cy = clamp(pose.hoverY + unit, opts.cyMin, opts.cyMax);
  if (ext.top < 0) unit = Math.min(unit, (cy - opts.topMargin) / -ext.top);
  unit = Math.max(unit, MIN_UNIT);
  const lo = x0 - ext.left * unit;
  const hi = x1 - ext.right * unit;
  const cx = lo <= hi ? clamp(pose.cx, lo, hi) : (x0 + x1) / 2;
  return { cx, cy, unit };
}

/** Pads in display space for an anchor. */
export function placeKit(anchor: KitAnchor, layout: KitLayout): PadGeometry[] {
  return Object.entries(layout).map(([id, p]) => ({
    id,
    x0: anchor.cx + (p.dx - p.halfWidth) * anchor.unit,
    x1: anchor.cx + (p.dx + p.halfWidth) * anchor.unit,
    y: anchor.cy + p.dy * anchor.unit,
  }));
}

/** Factor for every threshold written in h-units at `defaultUnit`: a player further back gets a smaller kit that triggers the same. */
export function kitScale(unit: number, opts: AnchorOptions): number {
  return clamp(unit / opts.defaultUnit, opts.scaleMin, opts.scaleMax);
}

function poseOf(samples: ReadonlyArray<AnchorSample>): KitPose {
  const n = samples.length;
  return {
    cx: samples.reduce((s, h) => s + h.tip.x, 0) / n,
    hoverY: samples.reduce((s, h) => s + h.tip.y, 0) / n,
    unit: samples.reduce((s, h) => s + h.palmSize, 0) / n,
  };
}

/**
 * Places one drummer's kit. The kit never moves while it is being played:
 * - not placed yet: the first time every hand of the player has been slow for
 *   `restMs`, the kit lands on them and stays there. If nobody pinned it and
 *   the hands are gone for `lostMs`, it lands again on the next visitor.
 * - placing (`toggle()`, the C key): the kit follows the resting hands, quickly
 *   (`tauMs`), in position, height and size, so the player sees what they get.
 * - `toggle()` again pins it exactly where it is drawn. Nothing jumps, and
 *   nothing moves it afterwards except another toggle or `reset()`.
 * A moving strike line cannot fire by itself: the crossing core needs the
 * hand's own speed to be above `vMin`.
 */
export class KitAnchorTracker {
  private pose: KitPose | null = null;
  private following = false;
  /** The player pinned the kit themselves: it no longer re-lands on a new visitor. */
  private pinned = false;
  private restSince: number | null = null;
  private lastHit = -Infinity;
  private lastSeen = -Infinity;
  private lastT: number | null = null;

  constructor(private readonly opts: () => AnchorOptions) {}

  /** 'auto': waiting to land on a player, or following them while they place it. 'locked': staying put. */
  get state(): 'auto' | 'locked' {
    return this.following || (!this.pose && !this.pinned) ? 'auto' : 'locked';
  }

  /** True once the kit has been placed on a player (before that it sits at the default). */
  get placed(): boolean {
    return this.pose !== null;
  }

  /** True while the player is placing the kit (between two presses of C). */
  get placing(): boolean {
    return this.following;
  }

  update(samples: ReadonlyArray<AnchorSample>, t: number): void {
    const o = this.opts();
    if (this.lastT !== null && t < this.lastT) {
      // The clock went back (a replay restarted): keep the pose, forget the timers.
      this.restSince = null;
      this.lastHit = -Infinity;
      this.lastSeen = t;
    }
    const dt = this.lastT === null ? 0 : clamp(t - this.lastT, 0, 100);
    this.lastT = t;

    if (samples.length === 0) {
      this.restSince = null;
      return;
    }
    if (!this.pinned && !this.following && t - this.lastSeen > o.lostMs) this.pose = null; // someone new: land on them
    this.lastSeen = t;
    if (!this.following && (this.pose || this.pinned)) return; // placed or pinned (even at the default): it stays put

    if (samples.some((s) => s.speed >= o.restVMax)) {
      this.restSince = null;
      return;
    }
    this.restSince ??= t;
    if (t - this.restSince < o.restMs || t - this.lastHit < o.freezeMs) return;

    const target = poseOf(samples);
    if (!this.pose) {
      this.pose = target;
      return;
    }
    const a = 1 - Math.exp(-dt / Math.max(1, o.tauMs));
    this.pose.cx += (target.cx - this.pose.cx) * a;
    this.pose.hoverY += (target.hoverY - this.pose.hoverY) * a;
    this.pose.unit += (target.unit - this.pose.unit) * a;
  }

  noteHit(t: number): void {
    this.lastHit = t;
  }

  /** Start placing the kit, or pin it where it is. Returns true while placing. */
  toggle(): boolean {
    this.following = !this.following;
    if (!this.following) this.pinned = true;
    this.restSince = null;
    return this.following;
  }

  /** Forget the player: back to the default, landing on the next resting pose. */
  reset(): void {
    this.pose = null;
    this.following = false;
    this.pinned = false;
    this.restSince = null;
    this.lastHit = -Infinity;
  }

  /** The anchor for this screen and region; the default pose (centre of the region) until a player has been seen. */
  anchor(layout: KitLayout, aspect: number, region: PlayerRegion): KitAnchor {
    const o = this.opts();
    const pose = this.pose ?? {
      cx: ((region.x0 + region.x1) / 2) * aspect,
      hoverY: o.defaultCy - o.defaultUnit,
      unit: o.defaultUnit,
    };
    return fitAnchor(pose, layout, o, aspect, region);
  }
}
