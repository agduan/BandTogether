import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseRecording, type Recording } from '@/vision/recorder';

/** Load a recording from public/recordings/<name>.json for fixture-driven tests. */
export function loadFixture(name: string): Recording {
  const file = resolve(process.cwd(), 'public/recordings', name.endsWith('.json') ? name : `${name}.json`);
  return parseRecording(readFileSync(file, 'utf8'));
}
