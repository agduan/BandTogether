import { useEffect, useMemo, useRef, useState } from 'react';
import { loadConfig } from './config';
import { Session, type SessionPhase, type SessionStats } from './session';
import type { SessionInfo, SongInfo } from './sessionInfo';
import { INSTRUMENT_IDS, INSTRUMENT_MODES, type PlayableInstrumentId } from './instruments';
import type { CameraInfo } from '@/vision/camera';
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

const INSTRUMENT_LABELS: Record<PlayableInstrumentId, { label: string; mark: string; hint: string }> = {
  drums: { label: 'Drums', mark: 'D', hint: 'Strike the pads' },
  guitar: { label: 'Guitar', mark: 'G', hint: 'Strum the song' },
  bass: { label: 'Bass', mark: 'B', hint: 'Pluck the groove' },
};

type KaraokeSongInfo = SongInfo & {
  /** Keona's future song seam; the UI already has a place for it. */
  nextChord?: string | null;
  countIn?: { active: boolean; beat: number; beats: number };
};

type KaraokeSessionInfo = Omit<SessionInfo, 'song'> & { song: KaraokeSongInfo };

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
  const [instrument, setInstrument] = useState<PlayableInstrumentId>('drums');
  const [mode, setMode] = useState<PlayMode>(config.play.mode);
  const [songId, setSongId] = useState(config.play.song);
  const [songRunning, setSongRunning] = useState(false);
  const [paused, setPaused] = useState(false);
  const [backingEnabled, setBackingEnabled] = useState(config.backing.enabled);
  const [sessionInfo, setSessionInfo] = useState<KaraokeSessionInfo | null>(null);
  const [micPending, setMicPending] = useState(false);
  const [echo, setEcho] = useState(config.singer.echo);
  const [reverb, setReverb] = useState(config.singer.reverb);
  const [, refreshConfig] = useState(0);

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const typing =
        ev.target instanceof HTMLInputElement || ev.target instanceof HTMLSelectElement || ev.target instanceof HTMLTextAreaElement;
      if (typing) return;
      if (ev.key === '`') setShowDebug((v) => !v);
      if (ev.key.toLowerCase() === 'c' && !ev.repeat) {
        sessionRef.current?.calibrate();
      }
      // Spacebar = kick pedal (any USB keyboard on the floor works).
      if (ev.code === 'Space') {
        ev.preventDefault();
        if (!ev.repeat && !sessionRef.current?.paused) sessionRef.current?.kick();
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
      const info = session.info() as KaraokeSessionInfo;
      setSessionInfo(info);
      setSongRunning(info.songRunning);
      setPaused(info.paused);
      setBackingEnabled(info.backing.enabled);
      setEcho(info.singer.echo);
      setReverb(info.singer.reverb);
    }, 250);

    return () => {
      window.clearInterval(statsTimer);
      session.stop();
      sessionRef.current = null;
      setSession(null);
      setSessionInfo(null);
    };
  }, [active, config]);

  const onPickCamera = async (id: string) => {
    setDeviceId(id);
    await sessionRef.current?.switchCamera(id);
  };

  const applyInstrument = (next: PlayableInstrumentId) => {
    if (next === instrument) return;
    const supportedModes = INSTRUMENT_MODES[next];
    const nextMode = supportedModes.includes(mode) ? mode : supportedModes[0];
    setInstrument(next);
    sessionRef.current?.setInstrument(next);
    if (nextMode !== mode) {
      setMode(nextMode);
      sessionRef.current?.setMode(nextMode);
      if (sessionRef.current?.songRunning) sessionRef.current.startSong();
    }
  };

  const applyMode = (next: PlayMode) => {
    if (next === mode || !INSTRUMENT_MODES[instrument].includes(next)) return;
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
    config.play.song = id;
    const s = sessionRef.current;
    if (s?.songRunning) s.startSong(id);
  };

  const resetPlacement = () => {
    sessionRef.current?.resetCalibration();
  };

  const toggleBacking = () => {
    const next = !backingEnabled;
    setBackingEnabled(next);
    sessionRef.current?.setBacking(next);
  };

  const toggleSinger = async () => {
    const current = sessionRef.current;
    if (!current || micPending) return;
    setMicPending(true);
    try {
      await current.singer.setEnabled(!current.singer.enabled);
      setSessionInfo(current.info() as KaraokeSessionInfo);
    } finally {
      setMicPending(false);
    }
  };

  const changeEcho = (amount: number) => {
    setEcho(amount);
    sessionRef.current?.singer.setEcho(amount);
  };

  const changeReverb = (amount: number) => {
    setReverb(amount);
    sessionRef.current?.singer.setReverb(amount);
  };

  const aspect = stats && stats.width > 0 ? `${stats.width} / ${stats.height}` : '4 / 3';
  const hardModeAvailable = INSTRUMENT_MODES[instrument].includes('hard');
  const songInfo = sessionInfo?.song;
  const singerInfo = sessionInfo?.singer;
  const songProgress =
    songInfo && songInfo.running && songInfo.barCount > 0
      ? (((songInfo.bar % songInfo.barCount) + (songInfo.beat + songInfo.beatPhase) / (sessionInfo?.beatsPerBar ?? 4)) /
          songInfo.barCount) *
        100
      : 0;

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
          <div className="control-section">
            <span className="control-label">Instrument</span>
            <div className="instrument-picker" role="radiogroup" aria-label="Instrument">
              {INSTRUMENT_IDS.map((id) => {
                const item = INSTRUMENT_LABELS[id];
                return (
                  <button
                    key={id}
                    type="button"
                    className="instrument-option"
                    data-instrument={id}
                    aria-checked={instrument === id}
                    role="radio"
                    disabled={!live}
                    onClick={() => applyInstrument(id)}
                    title={item.hint}
                  >
                    <span className="instrument-option__mark" aria-hidden="true">
                      {item.mark}
                    </span>
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="control-section">
            <span className="control-label">Play style</span>
            <div className="segmented" data-mode={mode} role="group" aria-label="Difficulty">
              <button
                type="button"
                onClick={() => applyMode('easy')}
                disabled={!live}
                aria-pressed={mode === 'easy'}
                title="Easy: the song chooses what you play."
              >
                Easy
              </button>
              <button
                type="button"
                onClick={() => applyMode('hard')}
                disabled={!live || !hardModeAvailable}
                aria-pressed={mode === 'hard'}
                title={hardModeAvailable ? 'Hard: your gesture chooses what you play.' : 'Guitar is easy mode only.'}
              >
                Hard
              </button>
            </div>
            <span className="control-note">
              {instrument === 'guitar'
                ? 'The song chooses the chord. You bring the rhythm.'
                : mode === 'easy'
                  ? 'The song keeps every move musical.'
                  : 'Your position chooses the sound.'}
            </span>
          </div>

          <div className="control-section">
            <span className="control-label">Session</span>
            <div className="control-actions">
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
                title="Freeze the camera, tracking, sound and song."
              >
                {paused ? '▶ Resume' : '⏸ Pause'}
              </button>
            </div>
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

          <div className="control-section">
            <span className="control-label">Placement</span>
            <div className="control-actions">
              <button className="btn" type="button" onClick={() => sessionRef.current?.calibrate()} disabled={!live}>
                ◎ Calibrate
              </button>
              <button className="btn btn--quiet" type="button" onClick={resetPlacement} disabled={!live}>
                Reset
              </button>
            </div>
            <span className="control-note">
              Press <kbd>C</kbd> with your hands in playing position.
            </span>
          </div>
        </div>

        <div className="stage" style={{ aspectRatio: aspect }}>
          <video ref={videoRef} className="stage__video" />
          <canvas ref={canvasRef} className="stage__canvas" />
          {live && (
            <div className="karaoke-hud" aria-live="polite">
              <div className="karaoke-hud__song">
                <span>{songInfo?.running ? songInfo.title : SONGS[songId]?.title}</span>
                <small>
                  {songInfo?.running
                    ? `${songInfo.section ?? 'Song'} · bar ${(songInfo.bar % Math.max(songInfo.barCount, 1)) + 1}`
                    : 'Choose a song, then press Play'}
                </small>
              </div>
              <div className="karaoke-hud__chords">
                <div>
                  <small>Now</small>
                  <strong>{songInfo?.chord ?? '—'}</strong>
                </div>
                <span aria-hidden="true">→</span>
                <div>
                  <small>Next</small>
                  <strong>{songInfo?.nextChord ?? '—'}</strong>
                </div>
              </div>
              <div className="karaoke-hud__beat" aria-label={`Beat ${(songInfo?.beat ?? 0) + 1}`}>
                {Array.from({ length: sessionInfo?.beatsPerBar ?? 4 }, (_, beat) => (
                  <i key={beat} data-active={songInfo?.running && beat === songInfo.beat ? '' : undefined} />
                ))}
              </div>
              <div className="karaoke-hud__progress" aria-hidden="true">
                <i style={{ width: `${songProgress}%` }} />
              </div>
            </div>
          )}
          {live && songInfo?.countIn?.active && (
            <div className="count-in" role="status">
              <span>Get ready</span>
              <strong>{Math.max(1, songInfo.countIn.beats - songInfo.countIn.beat)}</strong>
            </div>
          )}
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
            <span className="instrument-chip" data-instrument={instrument}>
              {INSTRUMENT_LABELS[instrument].label} · {mode}
            </span>
            <button
              type="button"
              className="backing-toggle backing-toggle--compact"
              aria-pressed={backingEnabled}
              disabled={!live}
              onClick={toggleBacking}
              title="Let the generated band fill the parts nobody is playing."
            >
              <span aria-hidden="true">{backingEnabled ? '●' : '○'}</span>
              Backing
              <strong>{backingEnabled ? 'On' : 'Off'}</strong>
            </button>
            <span className="hint">
              <kbd>C</kbd> calibrate · <kbd>space</kbd> kick
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

      <section className="singer-panel" aria-labelledby="singer-title">
        <div className="singer-panel__intro">
          <span className="singer-panel__mark" aria-hidden="true">
            V
          </span>
          <div>
            <span className="control-label">Optional layer</span>
            <h2 id="singer-title">Vocals</h2>
            <p>Sing while you play any instrument. Use wired headphones to avoid feedback.</p>
          </div>
        </div>

        <div className="singer-panel__mic">
          <button
            type="button"
            className="mic-button"
            data-enabled={singerInfo?.enabled ? '' : undefined}
            disabled={!live || micPending || singerInfo?.available === false}
            onClick={() => void toggleSinger()}
          >
            <span className="mic-button__dot" aria-hidden="true" />
            {micPending
              ? 'Requesting microphone…'
              : singerInfo?.available === false
                ? 'Microphone unavailable'
                : singerInfo?.enabled
                  ? 'Turn microphone off'
                  : 'Enable microphone'}
          </button>
          <div className="mic-level" aria-label={`Microphone level ${Math.round((singerInfo?.level ?? 0) * 100)}%`}>
            <span>Level</span>
            <i>
              <b style={{ width: `${Math.round((singerInfo?.level ?? 0) * 100)}%` }} />
            </i>
          </div>
          <small>Permission is requested only when you press Enable.</small>
        </div>

        <div className="singer-panel__effects">
          <label>
            <span>
              Echo <output>{Math.round(echo * 100)}%</output>
            </span>
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={echo}
              disabled={!live}
              onChange={(event) => changeEcho(Number(event.target.value))}
            />
          </label>
          <label>
            <span>
              Reverb <output>{Math.round(reverb * 100)}%</output>
            </span>
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={reverb}
              disabled={!live}
              onChange={(event) => changeReverb(Number(event.target.value))}
            />
          </label>
        </div>

        <div className="singer-panel__status" data-state={singerInfo?.error ? 'error' : singerInfo?.enabled ? 'live' : 'idle'}>
          <i />
          <span>
            {singerInfo?.error ??
              (singerInfo?.enabled ? 'Mic is live through the band mix' : live ? 'Vocals are off' : 'Start Band to enable vocals')}
          </span>
        </div>
      </section>

      {showDebug && session && <DebugPanel session={session} config={config} onClose={() => setShowDebug(false)} />}
    </section>
  );
}
