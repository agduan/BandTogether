import { useEffect, useMemo, useRef, useState } from 'react';
import { loadConfig } from './config';
import { Session, type SessionPhase, type SessionStats } from './session';
import type { CameraInfo } from '@/vision/camera';
import { bus } from '@/core/bus';
import type { PlayMode } from '@/core/types';
import { ConfigControls, DebugPanel, resetConfigControls } from '@/render/DebugPanel';
import { SONGS } from '@/song/songs';

const PHASE_TEXT: Record<SessionPhase, string> = {
  idle: '',
  camera: 'Opening camera…',
  model: 'Loading hand model…',
  audio: 'Loading sounds…',
  running: '',
  error: 'Something went wrong',
};

export function App() {
  const config = useMemo(() => loadConfig(), []);
  const [started, setStarted] = useState(config.debug.autostart);

  return (
    <main className="app">
      <header className="app__header">
        <div>
          <p className="app__eyebrow">A tiny webcam band</p>
          <h1 className="app__wordmark">
            Band Together<span aria-hidden="true">.</span>
          </h1>
        </div>
        <p className="app__tagline">Move like you mean it. We’ll handle the instruments.</p>
      </header>

      <Stage config={config} active={started} onStart={() => setStarted(true)} />
    </main>
  );
}

function Stage({
  config,
  active,
  onStart,
}: {
  config: ReturnType<typeof loadConfig>;
  active: boolean;
  onStart: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sessionRef = useRef<Session | null>(null);
  const [phase, setPhase] = useState<SessionPhase>('idle');
  const [detail, setDetail] = useState<string>('');
  const [stats, setStats] = useState<SessionStats | null>(null);
  const [cameras, setCameras] = useState<CameraInfo[]>([]);
  const [deviceId, setDeviceId] = useState('');
  const [session, setSession] = useState<Session | null>(null);
  const [showDebug, setShowDebug] = useState(config.debug.panel);
  const [mode, setMode] = useState<PlayMode>(config.play.mode);
  const [songId, setSongId] = useState(config.play.song);
  const [songRunning, setSongRunning] = useState(false);
  const [paused, setPaused] = useState(false);
  const [, refreshConfig] = useState(0);

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const typing =
        ev.target instanceof HTMLInputElement || ev.target instanceof HTMLSelectElement || ev.target instanceof HTMLTextAreaElement;
      if (typing) return;
      if (ev.key === '`') setShowDebug((v) => !v);
      // Spacebar = kick pedal (any USB keyboard on the floor works). Always a kick, in both modes.
      if (ev.code === 'Space') {
        ev.preventDefault();
        if (sessionRef.current?.paused) return;
        if (!ev.repeat) bus.emit({ type: 'drum.hit', t: performance.now(), playerId: 0, pad: 'kick', velocity: 0.9 });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (!active) return;

    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;

    const session = new Session(video, canvas, config);
    sessionRef.current = session;
    setSession(session);
    // Dev hook for console poking and headless checks: window.__airband.session
    if (import.meta.env.DEV) (window as unknown as { __airband?: unknown }).__airband = { session, config };
    session
      .start((p, d) => {
        setPhase(p);
        setDetail(d ?? '');
      })
      .then(async () => {
        setCameras(await session.listCameras());
        setDeviceId(session.currentDeviceId);
      })
      .catch(() => {});

    const statsTimer = window.setInterval(() => {
      setStats({ ...session.stats });
      setSongRunning(session.songRunning);
      setPaused(session.paused);
    }, 250);

    return () => {
      window.clearInterval(statsTimer);
      session.stop();
      sessionRef.current = null;
      setSession(null);
    };
  }, [active, config]);

  const onPickCamera = async (id: string) => {
    setDeviceId(id);
    await sessionRef.current?.switchCamera(id);
  };

  const applyMode = (next: PlayMode) => {
    if (next === mode) return;
    setMode(next);
    sessionRef.current?.setMode(next);
    // The auto kick belongs to easy mode: restart the clock so the option takes effect.
    if (sessionRef.current?.songRunning) sessionRef.current.startSong();
  };

  const toggleSong = () => {
    const s = sessionRef.current;
    if (!s) return;
    if (s.songRunning) s.stopSong();
    else s.startSong(songId);
    setSongRunning(s.songRunning);
  };

  const togglePause = () => {
    const s = sessionRef.current;
    if (!s) return;
    if (s.paused) s.resume();
    else s.pause();
    setPaused(s.paused);
  };

  const pickSong = (id: string) => {
    setSongId(id);
    const s = sessionRef.current;
    if (s?.songRunning) s.startSong(id);
    else if (s) s.config.play.song = id;
  };

  const aspect = stats && stats.width > 0 ? `${stats.width} / ${stats.height}` : '4 / 3';

  const live = active && phase === 'running';
  const status = !live
    ? { tone: 'wait', label: active ? PHASE_TEXT[phase] || 'Starting…' : 'Camera off' }
    : paused
      ? { tone: 'paused', label: 'Paused' }
      : songRunning
        ? { tone: 'live', label: 'Playing' }
        : { tone: 'idle', label: 'Ready' };

  return (
    <section className="stage-wrap">
      <div className="console">
        <div className="console__bar">
          <div className="console__group">
            <button
              className={`btn ${songRunning ? '' : 'btn--primary'}`}
              onClick={toggleSong}
              disabled={!live}
              title="Start or stop the song clock"
            >
              {songRunning ? '■ Stop' : '▶ Play'}
            </button>
            <button
              className={`btn ${paused ? 'btn--paused' : ''}`}
              onClick={togglePause}
              disabled={!live}
              title="Freeze the picture and stop tracking, sound and the song. Click again to carry on."
            >
              {paused ? '▶ Resume' : '⏸ Pause'}
            </button>
            <select
              className="select"
              value={songId}
              onChange={(e) => pickSong(e.target.value)}
              disabled={!live}
              aria-label="Song"
            >
              {Object.entries(SONGS).map(([id, s]) => (
                <option key={id} value={id}>
                  {s.title} · {s.bpm} bpm
                </option>
              ))}
            </select>
          </div>

          <div className="segmented" data-mode={mode} role="group" aria-label="Difficulty">
            <button
              type="button"
              onClick={() => applyMode('easy')}
              disabled={!live}
              aria-pressed={mode === 'easy'}
              title="Easy: the song picks the drum for you."
            >
              Easy
            </button>
            <button
              type="button"
              onClick={() => applyMode('hard')}
              disabled={!live}
              aria-pressed={mode === 'hard'}
              title="Hard: you play the pad you actually hit."
            >
              Hard
            </button>
          </div>
        </div>

        <div className="stage" style={{ aspectRatio: aspect }}>
          <video ref={videoRef} className="stage__video" />
          <canvas ref={canvasRef} className="stage__canvas" />
          {!active ? (
            <div className="stage__welcome">
              <p className="stage__kicker">Acapella is way overrated</p>
              <h2>Ready to band together?</h2>
              <button className="stage__start" onClick={onStart}>
                <span aria-hidden="true">▶</span> Start band
              </button>
            </div>
          ) : phase !== 'running' ? (
            <div className="stage__status">
              <p>{PHASE_TEXT[phase]}</p>
              {detail && <p className="stage__detail">{detail}</p>}
            </div>
          ) : null}
        </div>

        <div className="console__foot">
          <div className="console__group">
            <span className="status" data-tone={status.tone}>
              <i />
              {status.label}
            </span>
            <span className="hint">
              <kbd>space</kbd> kick · <kbd>`</kbd> debug
            </span>
          </div>
          <div className="console__group">
            <span className="readout">
              {stats && live
                ? `${stats.fps.toFixed(0)} fps · ${stats.inferenceMs.toFixed(1)} ms · ` +
                  `${stats.hands} hand${stats.hands === 1 ? '' : 's'} · ${stats.width}×${stats.height}`
                : detail}
            </span>
            {cameras.length > 1 && (
              <select
                className="select select--sm"
                value={deviceId}
                onChange={(e) => void onPickCamera(e.target.value)}
                aria-label="Camera"
              >
                {cameras.map((c) => (
                  <option key={c.deviceId} value={c.deviceId}>
                    {c.label}
                  </option>
                ))}
              </select>
            )}
            <button className="btn btn--quiet" onClick={() => setShowDebug((v) => !v)} title="Toggle debug panel (`)">
              Debug
            </button>
          </div>
          <details className="app__config">
            <summary>
              <span>Config</span>
              <button
                type="button"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  resetConfigControls(config);
                  refreshConfig((value) => value + 1);
                }}
              >
                Reset
              </button>
            </summary>
            <ConfigControls config={config} />
          </details>
        </div>
      </div>

      {showDebug && session && <DebugPanel session={session} config={config} onClose={() => setShowDebug(false)} />}
    </section>
  );
}
