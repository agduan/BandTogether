import type { HandFrame, Handedness, TrackId, Vec2 } from '@/core/types';
import type { BandGeometry } from '@/core/views';
import { clamp } from './detector';

/**
 * Hand roles from geometry: which of a player's hands strums (or plucks) and
 * which one frets. MediaPipe's handedness label is a prior only, so a swapped
 * or flipping label costs 0.4 of the score and never the whole decision.
 *
 *   score = 0.4·[label is the strumming hand] + 0.4·(1 − distance to the band) + 0.2·[x on the strumming side]
 *
 * argmax = strummer, the other hand = fretter. The assignment is sticky: a
 * challenger has to out-score the strummer for `swapMs` without a break before
 * they trade. A lone hand strums only if it scores at least `loneMinScore`
 * (near the band, or carrying the right label), so a fret hand left alone for
 * a few frames does not steal the role.
 *
 * Behaviour outranks the label. MediaPipe's Left/Right comes out flipped on
 * some laptops, and then a fret hand resting near the band would out-score the
 * real strummer for ever. So (a) a hand that strokes across the band while the
 * strummer has been idle for `swapMs` claims the role on the spot (`claim`),
 * and (b) a hand that strummed recently gets `activityWeight`, fading over
 * `activityMs`, on top of the formula, which keeps the claim from being
 * handed straight back.
 *
 * Player assignment (screen halves) is row 16 and lives in vision/frameAdapter.ts.
 */
export interface RoleOptions {
  /** Left-handed player: the band is mirrored, the strumming label is 'Left'. */
  lefty: boolean;
  /** A challenger must lead for this long before the roles swap (ms). */
  swapMs: number;
  /** Distance to the band (h) at which the proximity term reaches 0. */
  distScale: number;
  /** Minimum score for a lone hand to be the strummer. */
  loneMinScore: number;
  /** Score bonus for a hand that just strummed, fading linearly to 0 over `activityMs`. */
  activityWeight: number;
  activityMs: number;
}

export const DEFAULT_ROLE_OPTIONS: RoleOptions = { lefty: false, swapMs: 500, distScale: 0.5, loneMinScore: 0.4, activityWeight: 0.5, activityMs: 3000 };

export interface RoleAssignment {
  strumTrackId: TrackId | null;
  fretTrackId: TrackId | null;
}

export const NO_ROLES: RoleAssignment = { strumTrackId: null, fretTrackId: null };

/** Distance from a point to the band's box, 0 inside it (h). */
export function distToBand(p: Vec2, band: BandGeometry): number {
  const dx = Math.max(band.x0 - p.x, 0, p.x - band.x1);
  const dy = Math.max(band.y - band.halfHeight - p.y, 0, p.y - band.y - band.halfHeight);
  return Math.hypot(dx, dy);
}

/** How strummer-like one hand is, 0..1 (see the formula above). */
export function strumScore(hand: Pick<HandFrame, 'palm' | 'handedness'>, band: BandGeometry, opts: Pick<RoleOptions, 'lefty' | 'distScale'>): number {
  const strumLabel: Handedness = opts.lefty ? 'Left' : 'Right';
  const label = hand.handedness === strumLabel ? 1 : 0;
  const near = 1 - clamp(distToBand(hand.palm, band) / Math.max(1e-6, opts.distScale), 0, 1);
  // The neck leaves the band toward screen-left (screen-right for a lefty); the fret hand lives out there.
  const side = (opts.lefty ? hand.palm.x <= band.x1 : hand.palm.x >= band.x0) ? 1 : 0;
  return 0.4 * label + 0.4 * near + 0.2 * side;
}

/** Sticky strum/fret assignment for ONE player's hands. Pure state machine over frames. */
export class RoleAssigner {
  private current: RoleAssignment = NO_ROLES;
  private challenger: TrackId | null = null;
  private challengerSince = 0;
  /** When each track last fired a stroke. */
  private readonly lastStroke = new Map<TrackId, number>();

  constructor(private readonly opts: () => RoleOptions = () => DEFAULT_ROLE_OPTIONS) {}

  get roles(): RoleAssignment {
    return this.current;
  }

  /** `hands` must already be filtered to this player. */
  assign(hands: ReadonlyArray<HandFrame>, band: BandGeometry, t: number): RoleAssignment {
    const opts = this.opts();
    if (hands.length === 0) {
      this.challenger = null;
      return (this.current = NO_ROLES);
    }

    for (const id of this.lastStroke.keys()) if (!hands.some((h) => h.trackId === id)) this.lastStroke.delete(id);
    const scored = hands
      .map((hand) => ({ id: hand.trackId, score: strumScore(hand, band, opts) + opts.activityWeight * this.activity(hand.trackId, t, opts) }))
      .sort((a, b) => b.score - a.score);
    const best = scored[0];
    const incumbent = scored.find((s) => s.id === this.current.strumTrackId);

    let strum: TrackId | null;
    if (!incumbent) {
      // Nobody holds the role (first frame, or the strummer's track was lost): no waiting.
      this.challenger = null;
      strum = scored.length > 1 || best.score >= opts.loneMinScore ? best.id : null;
    } else if (best.id === incumbent.id || best.score <= incumbent.score) {
      this.challenger = null;
      strum = incumbent.id;
    } else {
      if (this.challenger !== best.id) {
        this.challenger = best.id;
        this.challengerSince = t;
      }
      const swap = t - this.challengerSince >= opts.swapMs;
      if (swap) this.challenger = null;
      strum = swap ? best.id : incumbent.id;
    }

    // The fretter is the hand that is left; with a stray third track, keep the one already fretting.
    const rest = scored.filter((s) => s.id !== strum);
    const fret = rest.find((s) => s.id === this.current.fretTrackId) ?? rest[rest.length - 1];
    return (this.current = { strumTrackId: strum, fretTrackId: fret ? fret.id : null });
  }

  /** Record that a track fired a stroke (feeds the activity bonus and `claim`). */
  noteStroke(trackId: TrackId, t: number): void {
    this.lastStroke.set(trackId, t);
  }

  /**
   * A hand that is not the strummer just made a valid stroke across the band.
   * It takes the role if nobody holds it or the holder has not strummed for
   * `swapMs`; the old strummer becomes the fretter. Returns whether it won.
   */
  claim(trackId: TrackId, t: number): boolean {
    const holder = this.current.strumTrackId;
    if (holder === trackId) return true;
    if (holder !== null && t - (this.lastStroke.get(holder) ?? -Infinity) < this.opts().swapMs) return false;
    const fret = holder ?? (this.current.fretTrackId !== trackId ? this.current.fretTrackId : null);
    this.current = { strumTrackId: trackId, fretTrackId: fret };
    this.challenger = null;
    return true;
  }

  reset(): void {
    this.current = NO_ROLES;
    this.challenger = null;
    this.challengerSince = 0;
    this.lastStroke.clear();
  }

  private activity(trackId: TrackId, t: number, opts: RoleOptions): number {
    const last = this.lastStroke.get(trackId);
    return last === undefined ? 0 : clamp(1 - (t - last) / Math.max(1, opts.activityMs), 0, 1);
  }
}
