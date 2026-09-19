import type { Vec2 } from '@/core/types';

/**
 * Segment-vs-line crossing state machine shared by the drum hit detector
 * (one instance per pad, downward only) and the strum detector (one instance
 * per strings band, both directions).
 *
 * Why crossing and not containment: at 4 h/s a hit moves ~0.13 h per frame,
 * more than a pad is tall, so "inside the pad and moving down" misses fast
 * hits and double-fires slow ones. Testing whether the segment from the
 * previous point to the current one crosses a horizontal strike line catches
 * every hit exactly once, and the interpolated crossing x tells which pad.
 *
 * Coordinates are whatever local frame the caller uses (display space for
 * drums, the guitar's (u, w) frame for strums); y increases "downward", i.e.
 * toward the strike direction.
 */
export interface CrossingOptions {
  /** y of the strike line in the local frame. */
  lineY: number;
  /** Horizontal extent of the line (inclusive). */
  x0: number;
  x1: number;
  /** Extra x slack on both ends, same units. */
  xTolerance: number;
  /** 'down': only downward crossings fire (drums). 'both': strums. */
  direction: 'down' | 'both';
  /** Minimum |vy| at the crossing to count (units/s). */
  vMin: number;
  /** Minimum |vy| / |v| (0 = no cone). Rejects lateral sweeps that dip through the line. */
  dirCos: number;
  /**
   * 'down' mode: after a strike the point must rise this far above the line to
   * re-arm. 'both' mode: Schmitt hysteresis half-band around the line.
   */
  rearmMargin: number;
  /** Same-direction refractory (ms). */
  refractoryMs: number;
  /** Opposite-direction refractory in 'both' mode (ms). */
  refractoryOppositeMs: number;
  /** Fire when the point *predicted* this far ahead crosses (ms). 0 disables. */
  anticipateMs: number;
}

export type CrossingDirection = 'down' | 'up';

export interface CrossingEvent {
  t: number;
  direction: CrossingDirection;
  /** Interpolated x where the segment met the line. */
  xAtCross: number;
  /** |vy| at the crossing, units/s. */
  speed: number;
  /** True if fired from the predicted position rather than an actual crossing. */
  anticipated: boolean;
}

type Side = 'above' | 'below' | 'unknown';

export class CrossingDetector {
  private side: Side = 'unknown';
  private prev: Vec2 | null = null;
  private lastFire: Record<CrossingDirection, number> = { down: -Infinity, up: -Infinity };

  constructor(readonly opts: CrossingOptions) {}

  get currentSide(): Side {
    return this.side;
  }

  /**
   * Feed one sample. `v` is the instantaneous velocity (units/s) and `dt` the
   * time since the previous sample of the same track (0 for a new or gapped
   * track, in which case the side is re-derived from position and nothing fires).
   */
  update(p: Vec2, v: Vec2, dt: number, t: number): CrossingEvent | null {
    const o = this.opts;

    if (dt <= 0 || this.prev === null || this.side === 'unknown') {
      this.side = this.sideOf(p.y);
      this.prev = p;
      return null;
    }

    const prev = this.prev;
    this.prev = p;

    // Position used for the crossing test: optionally predicted ahead.
    let yTest = p.y;
    let anticipated = false;
    if (o.anticipateMs > 0 && v.y !== 0) {
      const predicted = p.y + (v.y * o.anticipateMs) / 1000;
      const movingTowardLine = (v.y > 0 && p.y < o.lineY) || (v.y < 0 && p.y > o.lineY);
      if (movingTowardLine && this.crossesLine(prev.y, predicted) && !this.crossesLine(prev.y, p.y)) {
        yTest = predicted;
        anticipated = true;
      }
    }

    const newSide = this.sideOf(yTest);
    if (newSide === this.side) return null;

    // The side changed: compute the crossing direction.
    const direction: CrossingDirection = newSide === 'below' ? 'down' : 'up';
    this.side = newSide;

    if (direction === 'up' && o.direction === 'down') return null; // upstroke just re-arms

    const speed = Math.abs(v.y);
    const mag = Math.hypot(v.x, v.y);
    const cos = mag > 0 ? speed / mag : 0;
    const sinceSame = t - this.lastFire[direction];
    const sinceOther = t - this.lastFire[direction === 'down' ? 'up' : 'down'];

    const denom = yTest - prev.y;
    const xAtCross = denom !== 0 ? prev.x + ((p.x - prev.x) * (o.lineY - prev.y)) / denom : p.x;
    const inRange = xAtCross >= o.x0 - o.xTolerance && xAtCross <= o.x1 + o.xTolerance;

    if (speed < o.vMin || cos < o.dirCos || !inRange) return null;
    if (sinceSame < o.refractoryMs) return null;
    if (o.direction === 'both' && sinceOther < o.refractoryOppositeMs) return null;

    this.lastFire[direction] = t;
    return { t, direction, xAtCross, speed, anticipated };
  }

  reset(): void {
    this.side = 'unknown';
    this.prev = null;
    this.lastFire = { down: -Infinity, up: -Infinity };
  }

  private crossesLine(yA: number, yB: number): boolean {
    const L = this.opts.lineY;
    return (yA < L && yB >= L) || (yA >= L && yB < L);
  }

  /**
   * Side classification with hysteresis. 'down' mode is asymmetric: crossing
   * the line puts you below immediately, but you are only above again once
   * you retreat `rearmMargin` past it (absorbs the rebound bounce). 'both' mode
   * needs `rearmMargin` past the line in either direction (Schmitt trigger).
   */
  private sideOf(y: number): Side {
    const { lineY, rearmMargin, direction } = this.opts;
    if (this.side === 'unknown') return y >= lineY ? 'below' : 'above';
    if (direction === 'down') {
      if (this.side === 'above') return y >= lineY ? 'below' : 'above';
      return y < lineY - rearmMargin ? 'above' : 'below';
    }
    if (this.side === 'above') return y > lineY + rearmMargin ? 'below' : 'above';
    return y < lineY - rearmMargin ? 'above' : 'below';
  }
}
