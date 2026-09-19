import mitt, { type Emitter, type Handler, type WildcardHandler } from 'mitt';
import type { AppEvent, AppEventType } from './types';

/** Map each event `type` to its full event object, for typed subscriptions. */
export type BusEvents = { [K in AppEventType]: Extract<AppEvent, { type: K }> };

/**
 * Process-wide typed event bus. Instruments publish InstrumentEvents; audio,
 * renderer, recorder and HUD subscribe. Keep handlers cheap: they run on the
 * frame loop.
 */
export function createBus(): Bus {
  const emitter: Emitter<BusEvents> = mitt<BusEvents>();
  return {
    emit(event) {
      emitter.emit(event.type, event as BusEvents[typeof event.type]);
    },
    on(type, handler) {
      emitter.on(type, handler);
      return () => emitter.off(type, handler);
    },
    onAny(handler) {
      const wrapped: WildcardHandler<BusEvents> = (_type, event) => handler(event);
      emitter.on('*', wrapped);
      return () => emitter.off('*', wrapped);
    },
    clear() {
      emitter.all.clear();
    },
  };
}

export interface Bus {
  emit(event: AppEvent): void;
  /** Subscribe to one event type. Returns an unsubscribe function. */
  on<K extends AppEventType>(type: K, handler: Handler<BusEvents[K]>): () => void;
  /** Subscribe to every event (recorder, latency meter). */
  onAny(handler: (event: AppEvent) => void): () => void;
  clear(): void;
}

export const bus: Bus = createBus();
