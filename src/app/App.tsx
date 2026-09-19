import { useEffect, useMemo, useRef, useState } from 'react';
import { loadConfig } from './config';
import { Session, type SessionPhase, type SessionStats } from './session';
import type { CameraInfo } from '@/vision/camera';

const PHASE_TEXT: Record<SessionPhase, string> = {
  idle: '',
  camera: 'Opening camera…',
  model: 'Loading hand model…',
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

  useEffect(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;

    const session = new Session(video, canvas, config);
    sessionRef.current = session;
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

    const statsTimer = window.setInterval(() => setStats({ ...session.stats }), 250);

    return () => {
      window.clearInterval(statsTimer);
      session.stop();
      sessionRef.current = null;
    };
  }, [config]);

  const onPickCamera = async (id: string) => {
    setDeviceId(id);
    await sessionRef.current?.switchCamera(id);
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
              `${stats.width}×${stats.height} · ${stats.usingVideoFrameCallback ? 'rVFC' : 'rAF'}`
            : detail}
        </span>
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
    </section>
  );
}
