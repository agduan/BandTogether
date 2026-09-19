import { useMemo, useState } from 'react';
import { loadConfig } from './config';

/**
 * Product chrome. In PR 1 this is only the "Start Band" landing page; the
 * camera pipeline (PR 3), audio engine (PR 6) and instrument pickers (PR 17)
 * attach here in later PRs.
 */
export function App() {
  const config = useMemo(() => loadConfig(), []);
  const [started, setStarted] = useState(false);

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
        <p className="app__status">
          Band started. Camera tracking arrives in PR 3 and sound in PR 6.
        </p>
      )}

      <details className="app__config">
        <summary>Config (override with URL params, e.g. <code>?drum.vMin=1.4</code>)</summary>
        <pre>{JSON.stringify(config, null, 2)}</pre>
      </details>
    </main>
  );
}
