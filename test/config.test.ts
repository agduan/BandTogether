import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, applyOverrides, loadConfig, parseOverrides } from '@/app/config';

describe('config URL overrides', () => {
  it('parses dotted keys from a query string', () => {
    expect(parseOverrides('?drum.vMin=1.4&debug.panel=true')).toEqual({
      'drum.vMin': '1.4',
      'debug.panel': 'true',
    });
    expect(parseOverrides('')).toEqual({});
  });

  it('coerces numbers and booleans to the type of the default', () => {
    const { config, applied, rejected } = applyOverrides(DEFAULT_CONFIG, {
      'drum.vMin': '1.4',
      'debug.panel': 'true',
      'vision.delegate': 'CPU',
    });
    expect(config.drum.vMin).toBe(1.4);
    expect(config.debug.panel).toBe(true);
    expect(config.vision.delegate).toBe('CPU');
    expect(applied).toEqual(['drum.vMin', 'debug.panel', 'vision.delegate']);
    expect(rejected).toEqual([]);
  });

  it('rejects unknown keys and un-coercible values without mutating defaults', () => {
    const { config, applied, rejected } = applyOverrides(DEFAULT_CONFIG, {
      'drum.nope': '1',
      'drum.vMin': 'fast',
      'debug.panel': 'maybe',
    });
    expect(applied).toEqual([]);
    expect(rejected.map((r) => r.key)).toEqual(['drum.nope', 'drum.vMin', 'debug.panel']);
    expect(config).toEqual(DEFAULT_CONFIG);
    expect(DEFAULT_CONFIG.drum.vMin).toBe(1.0);
  });

  it('the instrument-lane sections (bass, singer, backing, players) take URL overrides', () => {
    const config = loadConfig('?bass.octave=-1&singer.echo=0.5&backing.enabled=false&players.count=2');
    expect(config.bass.octave).toBe(-1);
    expect(config.singer.echo).toBe(0.5);
    expect(config.backing.enabled).toBe(false);
    expect(config.players.count).toBe(2);
  });

  it('loadConfig applies a given search string outside the browser', () => {
    const config = loadConfig('?strum.hyst=0.03');
    expect(config.strum.hyst).toBe(0.03);
    expect(config.strum.vMin).toBe(DEFAULT_CONFIG.strum.vMin);
  });
});
