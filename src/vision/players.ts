/**
 * Which player a hand belongs to, and which slice of the frame a player owns.
 *
 * Two players share one picture: player 0 stands screen-left in the mirrored
 * view (`x < aspect / 2`), player 1 screen-right. A hand gets its player from
 * the half it is first seen in and keeps it for the life of its track, so a
 * big strum or a crash reach over the line still belongs to whoever made it.
 */
import type { Config } from '@/app/config';
import type { PlayerId, TrackId, VisionFrame } from '@/core/types';
import type { PlayerRegion } from '@/detectors/strumDetector';

export const MAX_PLAYERS = 2;

const WHOLE: PlayerRegion = { x0: 0, x1: 1 };
const HALVES: readonly PlayerRegion[] = [
  { x0: 0, x1: 0.5 },
  { x0: 0.5, x1: 1 },
];

/** The slice of the frame a player's instrument must stay inside: all of it alone, a half with two. */
export function regionFor(playerId: PlayerId, count: number): PlayerRegion {
  return count < 2 ? WHOLE : (HALVES[playerId] ?? WHOLE);
}

/** Player by screen half; `x` in h-units. */
export function playerAt(x: number, aspect: number, count: number): PlayerId {
  return count >= 2 && x >= aspect / 2 ? 1 : 0;
}

export interface AssignInput {
  trackId: TrackId;
  /** Palm x, display space (h). */
  x: number;
}

interface Entry {
  player: PlayerId;
  /** Set once the hand has been clearly inside a half; from then on it never changes player. */
  locked: boolean;
  lastT: number;
}

/** Forget a track unseen for this long (ms); well past the identity tracker's own expiry. */
const FORGET_MS = 1000;

/**
 * Sticky hand → player assignment. A hand born inside the dead zone around
 * the split is given the side it is on, but only provisionally: it locks the
 * first time it is seen outside the dead zone. Changing the player count
 * re-deals every hand.
 */
export class PlayerAssigner {
  private readonly entries = new Map<TrackId, Entry>();
  private count = 0;

  constructor(private readonly config: () => Config['players']) {}

  /** One player id per input, in order. */
  update(hands: ReadonlyArray<AssignInput>, aspect: number, t: number): PlayerId[] {
    const { count, deadZone } = this.config();
    if (count !== this.count) {
      this.entries.clear();
      this.count = count;
    }
    for (const [id, e] of this.entries) {
      // `lastT > t`: the clock went backwards (a replay looped), so the ids start over.
      if (t - e.lastT > FORGET_MS || e.lastT > t) this.entries.delete(id);
    }
    return hands.map(({ trackId, x }) => {
      let e = this.entries.get(trackId);
      if (!e) {
        e = { player: 0, locked: false, lastT: t };
        this.entries.set(trackId, e);
      }
      if (!e.locked) {
        e.player = playerAt(x, aspect, count);
        e.locked = count < 2 || Math.abs(x / aspect - 0.5) > deadZone;
      }
      e.lastT = t;
      return e.player;
    });
  }

  /** The same frame with every hand's player decided here (a recording is re-dealt for whoever plays now). */
  assign(frame: VisionFrame): VisionFrame {
    const ids = this.update(frame.hands.map((h) => ({ trackId: h.trackId, x: h.palm.x })), frame.aspect, frame.t);
    if (frame.hands.every((h, i) => h.playerId === ids[i])) return frame;
    return { ...frame, hands: frame.hands.map((h, i) => ({ ...h, playerId: ids[i] })) };
  }

  reset(): void {
    this.entries.clear();
  }
}
