import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ICON_NAMES, ICON_PATHS, iconPath } from './icons.ts';

describe('icon registry', () => {
  it('has every name the app draws', () => {
    for (const name of ['today', 'tasks', 'scouts', 'notes', 'log', 'chevron', 'check', 'close', 'calendar', 'run', 'dumbbell', 'note',
      'sun', 'part-cloud', 'cloud', 'fog', 'drizzle', 'rain', 'snow', 'storm']) expect(ICON_NAMES).toContain(name);
  });

  it('gives every name a non-empty, well-formed path', () => {
    for (const name of ICON_NAMES) {
      const d = iconPath(name);
      expect(d.trim(), name).not.toBe('');
      expect(d, name).toMatch(/^[Mm]/);
      expect(d, name).toMatch(/^[MmLlHhVvCcSsQqTtAaZz0-9\s.,-]+$/);
    }
    expect(Object.keys(ICON_PATHS)).toHaveLength(ICON_NAMES.length);
  });
});

describe('no emoji or disclosure glyph in the UI components', () => {
  const dir = fileURLToPath(new URL('.', import.meta.url));
  const files = readdirSync(dir).filter((f) => f.endsWith('.tsx'));
  const banned = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}▶▸▾]/u;
  it.each(files)('%s', (file) => {
    expect(banned.test(readFileSync(dir + file, 'utf8'))).toBe(false);
  });
});
