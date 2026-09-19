import type { InstrumentId, Voice } from '@/core/types';

/** A voice that makes no sound: stands in for an instrument whose sampler has not landed yet. */
export class SilentVoice implements Voice {
  constructor(readonly id: InstrumentId) {}

  load(): Promise<void> {
    return Promise.resolve();
  }

  trigger(): void {}

  releaseAll(): void {}
}
