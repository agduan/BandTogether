import { useEffect, useMemo, useRef, useState } from 'react';
import { loadConfig } from './config';
import { Session, type SessionPhase, type SessionStats } from './session';
import type { CameraInfo } from '@/vision/camera';
import { bus } from '@/core/bus';
import type { PlayMode } from '@/core/types';
import { DebugPanel } from '@/render/DebugPanel';
import { SONGS } from '@/song/songs';

const PHASE_TEXT: Record<SessionPhase, string> = {
  idle: '',
  camera: 'Opening camera…',
  model: 'Loading hand model…',
  audio: 'Loading sounds…',
  running: '',
  error: 'Something went wrong',
};

/**
 * Product chrome: Start Band landing page, then the camera stage with the
 * skeleton overlay and a small stats line. Instrument pickers arrive in
 * commit 17; the debug panel in commit 5.
 */
export function App() {
  const config = useMemo(() => loadConfig(), []);
  const [started, setStarted] = useState(config.debug.autostart);

  return (
    <main className="app">
      <header className="app__header">
        <h1>Air Band</h1>
        <p className="app__tagline">Play guitar and drums in the air. No instrument, no lessons.</p>
      </header>

      {!started ? (
        <button className="app__start" onClick={() => setStarted(true)}>
          Start Band
        </button>
      ) : (
        <Stage config={config} />
      )}

      <details className="app__config">
        <summary>Config (override with URL params, e.g. <code>?drum.vMin=1.4</code>)</summary>
        <pre>{JSON.stringify(config, null, 2)}</pre>
      </details>
    </main>
  );
}

function Stage({ config }: { config: ReturnType<typeof loadConfig> }) {
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
  }, [config]);

  const onPickCamera = async (id: string) => {
    setDeviceId(id);
    await sessionRef.current?.switchCamera(id);
  };

  const toggleMode = () => {
    const next: PlayMode = mode === 'easy' ? 'hard' : 'easy';
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

  return (
    <section className="stage-wrap">
      <div className="stage" style={{ aspectRatio: aspect }}>
        <video ref={videoRef} className="stage__video" />
        <canvas ref={canvasRef} className="stage__canvas" />
        {phase !== 'running' && (
          <div className="stage__status">
            <p>{PHASE_TEXT[phase]}</p>
            {detail && <p className="stage__detail">{detail}</p>}
          </div>
        )}
      </div>

      <div className="stage__bar">
        <span className="stage__stats">
          {stats && phase === 'running'
            ? `${stats.fps.toFixed(0)} fps · inference ${stats.inferenceMs.toFixed(1)} ms · ` +
              `${stats.hands} hand${stats.hands === 1 ? '' : 's'} · ${stats.delegate} · ` +
              `${stats.width}×${stats.height} · ${stats.usingVideoFrameCallback ? 'rVFC' : 'rAF'} · ` +
              `audio ${sessionRef.current?.audio.state ?? '-'}` +
              (paused ? ' · PAUSED' : '')
            : detail}
        </span>
        <span className="stage__controls">
          <button
            className={`stage__btn ${paused ? 'stage__btn--paused' : ''}`}
            onClick={togglePause}
            disabled={phase !== 'running'}
            title="Freeze the picture and stop tracking, sound and the song. Click again to carry on."
          >
            {paused ? '▶ resume band' : '⏸ pause band'}
          </button>
          <button
            className={`stage__btn ${mode === 'easy' ? 'stage__btn--easy' : 'stage__btn--hard'}`}
            onClick={toggleMode}
            disabled={phase !== 'running'}
            title="Easy: the song picks the drum. Hard: the pad you hit."
          >
            {mode === 'easy' ? 'EASY' : 'HARD'}
          </button>
          <select
            className="stage__camera"
            value={songId}
            onChange={(e) => pickSong(e.target.value)}
            disabled={phase !== 'running'}
            aria-label="Song"
          >
            {Object.entries(SONGS).map(([id, s]) => (
              <option key={id} value={id}>
                {s.title} · {s.bpm} bpm
              </option>
            ))}
          </select>
          <button className="stage__btn" onClick={toggleSong} disabled={phase !== 'running'} title="Start/stop the song clock">
            {songRunning ? '■ stop' : '▶ play'}
          </button>
          <span className="stage__hint">space = kick</span>
        </span>
        <button className="stage__debug-toggle" onClick={() => setShowDebug((v) => !v)} title="Toggle debug panel (`)">
          debug
        </button>
        {cameras.length > 1 && (
          <select
            className="stage__camera"
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
      </div>

      {showDebug && session && <DebugPanel session={session} config={config} onClose={() => setShowDebug(false)} />}
    </section>
  );
}
