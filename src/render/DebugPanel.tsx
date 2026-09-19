import { useEffect, useRef, useState } from 'react';
import type { Config } from '@/app/config';
import { DEFAULT_CONFIG } from '@/app/config';
import { INJECTOR_KEYS, injectFromKey } from '@/app/injector';
import type { Session } from '@/app/session';
import { bus } from '@/core/bus';
import type { AppEvent, HandFrame } from '@/core/types';
import { downloadRecording, parseRecording } from '@/vision/recorder';

/** Numeric/boolean config leaves exposed as live controls (dotted path, min, max, step). */
const CONTROLS: ReadonlyArray<{ path: string; min?: number; max?: number; step?: number }> = [
  { path: 'vision.swapHandedness' },
  { path: 'vision.minPalmSize', min: 0, max: 0.2, step: 0.005 },
  { path: 'filter.minCutoff', min: 0.1, max: 5, step: 0.1 },
  { path: 'filter.beta', min: 0, max: 10, step: 0.1 },
  { path: 'filter.glitchClamp', min: 2, max: 30, step: 0.5 },
  { path: 'drum.vMin', min: 0.2, max: 4, step: 0.05 },
  { path: 'drum.vMax', min: 1, max: 10, step: 0.1 },
  { path: 'drum.stickLen', min: 0.5, max: 3, step: 0.1 },
  { path: 'drum.rearmMargin', min: 0, max: 0.15, step: 0.005 },
  { path: 'drum.anticipateMs', min: 0, max: 80, step: 5 },
  { path: 'drum.dirCos', min: 0, max: 1, step: 0.05 },
  { path: 'drum.refractoryMs', min: 0, max: 300, step: 10 },
  { path: 'drum.padTolerance', min: 0, max: 0.1, step: 0.005 },
  { path: 'strum.hyst', min: 0, max: 0.1, step: 0.005 },
  { path: 'strum.vMin', min: 0.1, max: 3, step: 0.05 },
  { path: 'debug.skeleton' },
];

function getLeaf(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], obj);
}

function setLeaf(obj: unknown, path: string, value: unknown): void {
  const keys = path.split('.');
  const leaf = keys.pop()!;
  const parent = keys.reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], obj) as Record<string, unknown>;
  parent[leaf] = value;
}

/** `?a.b=1&c.d=true` for every control that differs from the defaults. */
export function overridesQuery(config: Config): string {
  const parts: string[] = [];
  for (const c of CONTROLS) {
    const v = getLeaf(config, c.path);
    if (v !== getLeaf(DEFAULT_CONFIG, c.path)) parts.push(`${c.path}=${String(v)}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

export function resetConfigControls(config: Config): void {
  for (const control of CONTROLS) {
    setLeaf(config, control.path, getLeaf(DEFAULT_CONFIG, control.path));
  }
}

export function ConfigControls({ config }: { config: Config }) {
  const [, force] = useState(0);
  const query = overridesQuery(config);

  return (
    <div className="config-controls">
      {CONTROLS.map((c) => {
        const value = getLeaf(config, c.path);
        return (
          <label key={c.path} className="config-control">
            <span>{c.path}</span>
            {typeof value === 'boolean' ? (
              <input
                type="checkbox"
                checked={value}
                onChange={(e) => {
                  setLeaf(config, c.path, e.target.checked);
                  force((n) => n + 1);
                }}
              />
            ) : (
              <>
                <code>{String(value)}</code>
                <input
                  type="range"
                  min={c.min}
                  max={c.max}
                  step={c.step}
                  value={value as number}
                  onChange={(e) => {
                    setLeaf(config, c.path, Number(e.target.value));
                    force((n) => n + 1);
                  }}
                />
              </>
            )}
          </label>
        );
      })}
      <div className="config-controls__footer">
        <span>{query || 'Using defaults'}</span>
        {query && (
          <div>
          <button onClick={() => void navigator.clipboard.writeText(`${location.origin}${location.pathname}${query}`)}>
            Copy URL
          </button>
          </div>
        )}
      </div>
    </div>
  );
}

interface Props {
  session: Session;
  config: Config;
  onClose: () => void;
}

/**
 * Developer panel: live stats, per-track detail, config sliders bound to the
 * shared Config object, record/replay controls, and the keyboard injector.
 * Toggle with the backtick key. Filter changes apply to newly seen hands.
 */
export function DebugPanel({ session, config, onClose }: Props) {
  const [, force] = useState(0);
  const rerender = () => force((n) => n + 1);
  const [hands, setHands] = useState<HandFrame[]>([]);
  const [lastEvent, setLastEvent] = useState<string>('—');
  const [recording, setRecording] = useState(false);
  const [replay, setReplay] = useState<{ name: string; frames: number } | null>(null);
  const [loop, setLoop] = useState(true);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setHands(session.lastFrame?.hands ?? []);
      setRecording(session.isRecording);
      rerender();
    }, 250);
    const off = bus.onAny((e: AppEvent) => {
      if (e.type === 'vision.frame') return;
      setLastEvent(`${e.type} ${JSON.stringify({ ...e, type: undefined })}`);
    });
    const onKey = (ev: KeyboardEvent) => {
      if (ev.target instanceof HTMLInputElement || ev.target instanceof HTMLSelectElement) return;
      if (ev.key === 'r' || ev.key === 'R') return toggleRecord();
      if (injectFromKey(ev.key)) ev.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.clearInterval(timer);
      off();
      window.removeEventListener('keydown', onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  const toggleRecord = () => {
    if (session.isRecording) {
      const rec = session.stopRecording();
      if (rec.frames.length) downloadRecording(rec);
    } else {
      session.startRecording();
    }
    setRecording(session.isRecording);
  };

  const loadFile = async (file: File) => {
    const rec = parseRecording(await file.text());
    session.replay(rec, { loop });
    setReplay({ name: file.name, frames: rec.frames.length });
  };

  const stopReplay = () => {
    session.stopReplay();
    setReplay(null);
  };

  const { stats } = session;
  return (
    <aside className="debug">
      <header className="debug__head">
        <strong>Debug</strong>
        <span>
          {stats.fps.toFixed(0)} fps · {stats.inferenceMs.toFixed(1)} ms · {stats.delegate} · {session.source}
        </span>
        <button onClick={onClose} aria-label="Close debug panel">
          ×
        </button>
      </header>

      <section>
        <h4>Hands</h4>
        {hands.length === 0 && <p className="debug__muted">none</p>}
        {hands.map((h) => (
          <div key={h.trackId} className="debug__row">
            #{h.trackId} {h.handedness === 'Left' ? 'L' : 'R'} {h.handednessScore.toFixed(2)} · dt {h.dt.toFixed(0)} ·
            palm ({h.palm.x.toFixed(2)}, {h.palm.y.toFixed(2)}) · v ({h.palmVel.x.toFixed(1)}, {h.palmVel.y.toFixed(1)}) ·
            size {h.palmSize.toFixed(3)}
          </div>
        ))}
      </section>

      <section>
        <h4>Audio · latency</h4>
        <p className="debug__row">
          {session.audio.state} · pipeline {session.audio.latency.stats.pipelineMs.toFixed(1)} ms (frame → scheduled) ·
          output {session.audio.latency.stats.outputMs.toFixed(1)} ms · {session.audio.latency.stats.count} sounds
        </p>
      </section>

      <section>
        <h4>Last event</h4>
        <p className="debug__event">{lastEvent}</p>
        <p className="debug__muted">
          Inject: {INJECTOR_KEYS.map((k) => `${k.key}=${k.describe}`).join(' · ')}
        </p>
      </section>

      <section>
        <h4>Record / replay</h4>
        <div className="debug__controls">
          <button onClick={toggleRecord}>{recording ? `■ Stop (${session.recordedFrames})` : '● Record (R)'}</button>
          <button onClick={() => fileRef.current?.click()}>Load recording…</button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void loadFile(f);
              e.target.value = '';
            }}
          />
          <label>
            <input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} /> loop
          </label>
          {replay && (
            <button onClick={stopReplay}>
              Stop replay ({replay.name}, {replay.frames} frames)
            </button>
          )}
        </div>
      </section>

      <section>
        <h4>Config</h4>
        <ConfigControls config={config} />
      </section>
    </aside>
  );
}
