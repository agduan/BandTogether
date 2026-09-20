import { bus } from '@/core/bus';
import type { Instrument, InstrumentEvent, NoteResolver, PlayerId, SongContext, VisionFrame } from '@/core/types';
import { FREEPLAY_CONTEXT } from '@/audio/modes';

/** The slice of the audio engine a controller needs: latency stamping. */
export interface LatencySink {
  stamp(source: InstrumentEvent, detectT: number): void;
}

export interface ControllerOptions {
  playerId: PlayerId;
  instrument: Instrument;
  resolver: NoteResolver;
  audio: LatencySink;
  /** Song clock accessor; defaults to free play until commit 9 wires the clock. */
  song?: () => SongContext;
}

const EVENT_TYPES_BY_INSTRUMENT = {
  drums: ['drum.hit'],
  guitar: ['guitar.strum'],
  bass: ['bass.pluck'],
} as const satisfies Record<Instrument['id'], readonly InstrumentEvent['type'][]>;

/**
 * One player on one instrument. Every frame: filter the player's hands, run
 * the instrument's detectors, publish their events. Every published event of
 * this instrument for this player (whether from a detector or the keyboard
 * injector) is then resolved by the mode and sent to the voice, so there is a
 * single path from gesture to sound. The bus is synchronous, so the detour
 * costs microseconds, and the recorder, HUD and FX see the same events.
 */
export class InstrumentController {
  readonly playerId: PlayerId;
  readonly instrument: Instrument;
  resolver: NoteResolver;
  song: () => SongContext;
  private readonly audio: LatencySink;
  private readonly unsubscribe: () => void;
  private disposed = false;
  private isMuted = false;

  constructor(opts: ControllerOptions) {
    this.playerId = opts.playerId;
    this.instrument = opts.instrument;
    this.resolver = opts.resolver;
    this.audio = opts.audio;
    this.song = opts.song ?? (() => FREEPLAY_CONTEXT);
    this.unsubscribe = bus.onAny((e) => {
      if (this.isMuted || !('playerId' in e) || e.playerId !== this.playerId) return;
      if (!(EVENT_TYPES_BY_INSTRUMENT[this.instrument.id] as readonly string[]).includes(e.type)) return;
      this.play(e as InstrumentEvent);
    });
  }

  /** Run the detectors on one frame and publish what they find. */
  onFrame(frame: VisionFrame): void {
    if (this.disposed || this.isMuted) return;
    for (const det of this.instrument.detectors) {
      for (const e of det.update(frame)) bus.emit(e);
    }
  }

  get muted(): boolean {
    return this.isMuted;
  }

  /**
   * A muted controller detects nothing and plays nothing (injected events
   * included). Muting cuts what is ringing; unmuting starts the detectors
   * clean, so the first frame back cannot fire a phantom hit.
   */
  set muted(on: boolean) {
    if (on === this.isMuted) return;
    this.isMuted = on;
    this.reset();
  }

  reset(): void {
    for (const det of this.instrument.detectors) det.reset();
    this.instrument.voice.releaseAll();
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribe();
    this.instrument.dispose?.();
  }

  /** Resolve one event with the active mode and trigger the voice. */
  private play(e: InstrumentEvent): void {
    const detectT = performance.now();
    const song = this.song();
    const { voice } = this.instrument;
    switch (e.type) {
      case 'drum.hit':
        voice.trigger(this.resolver.resolveDrum(e, song));
        break;
      case 'guitar.strum': {
        const r = this.resolver.resolveStrum(e, song);
        if (r.notes.some((n) => n !== null)) voice.trigger(r);
        else return;
        break;
      }
      case 'bass.pluck': {
        const r = this.resolver.resolveBass(e, song);
        if (r.notes.some((n) => n !== null)) voice.trigger(r);
        else return;
        break;
      }
      default:
        return;
    }
    this.audio.stamp(e, detectT);
  }
}
