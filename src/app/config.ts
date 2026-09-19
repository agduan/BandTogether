/**
 * Single runtime configuration object.
 *
 * Every tunable threshold in the app lives here so that on-site tuning needs
 * no rebuild: any leaf can be overridden from the URL with a dotted path,
 * e.g. `?drum.vMin=1.4&debug.skeleton=true`. Values are coerced to the type
 * of the default they replace; unknown keys are reported and ignored.
 *
 * Units follow the project conventions (see core/types.ts): geometry in
 * frame-height units ("h"), velocities in h/s, times in ms.
 */

/**
 * One drum pad: x-range as fractions of the frame width, strike line y in
 * frame-height units. Converted to display space per frame (x · aspect).
 */
export interface KitPad {
  x0: number;
  x1: number;
  y: number;
}

export interface Config {
  camera: {
    width: number;
    height: number;
    idealFps: number;
    /** getUserMedia deviceId; empty string = browser default. */
    deviceId: string;
  };
  vision: {
    numHands: number;
    minDetectionConfidence: number;
    minPresenceConfidence: number;
    minTrackingConfidence: number;
    delegate: 'GPU' | 'CPU';
    /** Flip MediaPipe's Left/Right label. Verify empirically on each laptop. */
    swapHandedness: boolean;
    /** Ignore hands smaller than this palm size (h). Filters background people. */
    minPalmSize: number;
  };
  tracker: {
    maxJump: number;
    dedupeDist: number;
    expiryMs: number;
    handednessVoteFrames: number;
  };
  filter: {
    /** One-Euro filter for the render (smooth) stream only. */
    minCutoff: number;
    beta: number;
    dCutoff: number;
    /** Velocity buffer guards. */
    dtMinMs: number;
    dtGapMs: number;
    glitchClamp: number;
  };
  drum: {
    trackedPoint: 'tip' | 'palm';
    stickLen: number;
    vMin: number;
    vMax: number;
    rearmMargin: number;
    refractoryMs: number;
    padRefractoryMs: number;
    dirCos: number;
    anticipateMs: number;
    padTolerance: number;
    /** Drawn half-height of a pad around its strike line (h). Visual only. */
    padHalfHeight: number;
    /** Kit layout keyed by sample name. Override a leaf with e.g. `?drum.kit.snare.y=0.7`. */
    kit: Record<string, KitPad>;
  };
  strum: {
    hyst: number;
    vMin: number;
    vMax: number;
    floor: number;
    refractorySameMs: number;
    refractoryOppositeMs: number;
    /** Band geometry as fractions of the frame (converted to h-units once). */
    bandY: number;
    bandHalfHeight: number;
    bandXMin: number;
    bandXMax: number;
    useVelocityOnset: boolean;
  };
  chord: {
    k: number;
    minP: number;
    unknownDistFactor: number;
    emaTauMs: number;
    switchP: number;
    switchMargin: number;
    switchFrames: number;
    unknownP: number;
    unknownMs: number;
    stickyMs: number;
    latchMs: number;
  };
  audio: {
    lookAhead: number;
    latencyHint: 'interactive' | 'balanced' | 'playback';
  };
  debug: {
    panel: boolean;
    skeleton: boolean;
    latencyMeter: boolean;
    /** Skip the Start button and open the camera on load (kiosk/demo and headless checks). */
    autostart: boolean;
  };
}

export const DEFAULT_CONFIG: Config = {
  camera: { width: 640, height: 480, idealFps: 60, deviceId: '' },
  vision: {
    numHands: 2,
    minDetectionConfidence: 0.5,
    minPresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
    delegate: 'GPU',
    swapHandedness: false,
    minPalmSize: 0.05,
  },
  tracker: { maxJump: 0.25, dedupeDist: 0.03, expiryMs: 300, handednessVoteFrames: 15 },
  filter: { minCutoff: 1.0, beta: 3.0, dCutoff: 1.0, dtMinMs: 8, dtGapMs: 120, glitchClamp: 12 },
  drum: {
    trackedPoint: 'tip',
    stickLen: 1.5,
    vMin: 1.0,
    vMax: 4.0,
    rearmMargin: 0.04,
    refractoryMs: 80,
    padRefractoryMs: 30,
    dirCos: 0.6,
    anticipateMs: 0,
    padTolerance: 0.03,
    padHalfHeight: 0.06,
    // Arranged like a kit seen from the drummer's seat, in the mirrored view:
    // hi-hat and snare on the left, toms across the top, crash top-right,
    // kick low in the middle (awkward by hand; easy mode auto-plays it).
    kit: {
      hihat: { x0: 0.17, x1: 0.34, y: 0.5 },
      snare: { x0: 0.31, x1: 0.51, y: 0.68 },
      tom1: { x0: 0.53, x1: 0.7, y: 0.5 },
      tom2: { x0: 0.73, x1: 0.87, y: 0.55 },
      crash: { x0: 0.79, x1: 0.96, y: 0.4 },
      kick: { x0: 0.48, x1: 0.65, y: 0.85 },
    },
  },
  strum: {
    hyst: 0.02,
    vMin: 0.5,
    vMax: 3.0,
    floor: 0.35,
    refractorySameMs: 60,
    refractoryOppositeMs: 40,
    bandY: 0.62,
    bandHalfHeight: 0.05,
    bandXMin: 0.53,
    bandXMax: 0.81,
    useVelocityOnset: false,
  },
  chord: {
    k: 7,
    minP: 0.5,
    unknownDistFactor: 2.0,
    emaTauMs: 150,
    switchP: 0.6,
    switchMargin: 0.2,
    switchFrames: 3,
    unknownP: 0.45,
    unknownMs: 300,
    stickyMs: 1500,
    latchMs: 50,
  },
  audio: { lookAhead: 0.01, latencyHint: 'interactive' },
  debug: { panel: false, skeleton: true, latencyMeter: false, autostart: false },
};

/** Parse `?a.b=1&c=true` into a flat map of dotted paths to raw strings. */
export function parseOverrides(search: string): Record<string, string> {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const out: Record<string, string> = {};
  for (const [key, value] of params) {
    if (key.trim().length > 0) out[key.trim()] = value;
  }
  return out;
}

export interface ApplyResult {
  config: Config;
  applied: string[];
  rejected: { key: string; reason: string }[];
}

/**
 * Return a deep copy of `base` with each dotted-path override applied, coercing
 * the raw string to the type of the existing leaf. Never mutates `base`.
 */
export function applyOverrides(base: Config, overrides: Record<string, string>): ApplyResult {
  const config = structuredClone(base);
  const applied: string[] = [];
  const rejected: ApplyResult['rejected'] = [];

  for (const [path, raw] of Object.entries(overrides)) {
    const segments = path.split('.');
    const leafKey = segments.pop();
    if (!leafKey) {
      rejected.push({ key: path, reason: 'empty path' });
      continue;
    }

    let node: unknown = config;
    for (const segment of segments) {
      if (node !== null && typeof node === 'object' && segment in (node as object)) {
        node = (node as Record<string, unknown>)[segment];
      } else {
        node = undefined;
        break;
      }
    }

    if (node === null || typeof node !== 'object' || !(leafKey in (node as object))) {
      rejected.push({ key: path, reason: 'unknown key' });
      continue;
    }

    const target = node as Record<string, unknown>;
    const current = target[leafKey];
    const coerced = coerceLike(current, raw);
    if (coerced === undefined) {
      rejected.push({ key: path, reason: `cannot coerce "${raw}" to ${typeof current}` });
      continue;
    }
    target[leafKey] = coerced;
    applied.push(path);
  }

  return { config, applied, rejected };
}

function coerceLike(current: unknown, raw: string): unknown {
  switch (typeof current) {
    case 'number': {
      const n = Number(raw);
      return Number.isFinite(n) ? n : undefined;
    }
    case 'boolean': {
      if (raw === 'true' || raw === '1') return true;
      if (raw === 'false' || raw === '0') return false;
      return undefined;
    }
    case 'string':
      return raw;
    default:
      return undefined;
  }
}

/** Build the runtime config from defaults plus the page URL (no-op outside a browser). */
export function loadConfig(search?: string): Config {
  const query = search ?? (typeof window !== 'undefined' ? window.location.search : '');
  const { config, rejected } = applyOverrides(DEFAULT_CONFIG, parseOverrides(query));
  for (const r of rejected) console.warn(`[config] ignored override "${r.key}": ${r.reason}`);
  return config;
}
