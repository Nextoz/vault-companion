// Redesign R1 (review #5): every text/background pair the app relies on meets WCAG AA (4.5:1) on the surface it is
// drawn on. Reads tokens.css itself, so a new colour that regresses a pair fails here instead of on the phone outdoors.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

function block(selector: string): Map<string, string> {
  const match = new RegExp(`(^|\\n)${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`).exec(css);
  if (!match) throw new Error(`tokens.css has no ${selector} block`);
  const map = new Map<string, string>();
  for (const [, name = '', value = ''] of (match[2] ?? '').matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) map.set(name, value.trim());
  return map;
}

const root = block(':root');

function resolve(name: string): string {
  const value = root.get(name);
  if (value === undefined) throw new Error(`unknown token ${name}`);
  const ref = /^var\((--[\w-]+)\)$/.exec(value);
  return ref?.[1] ? resolve(ref[1]) : value;
}

function luminance(hex: string): number {
  const digits = /^#([0-9a-f]{6})$/i.exec(hex)?.[1];
  if (!digits) throw new Error(`not a 6-digit hex colour: ${hex}`);
  const linear = (i: number) => {
    const c = parseInt(digits.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(0) + 0.7152 * linear(2) + 0.0722 * linear(4);
}

function contrast(fg: string, bg: string): number {
  const [x, y] = [luminance(fg), luminance(bg)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

describe('design tokens meet WCAG AA', () => {
  const bg = resolve('--bg');
  const card = resolve('--surface');
  const raised = resolve('--raised');

  const pairs: [string, string, string][] = [
    ['--text', '--bg', bg], ['--text', '--surface', card], ['--text', '--raised', raised],
    ['--muted', '--bg', bg], ['--muted', '--surface', card], ['--muted-on-raised', '--raised', raised],
    ['--accent', '--bg', bg], ['--accent', '--surface', card], ['--accent-on-raised', '--raised', raised],
    ['--warn', '--surface', card], ['--danger', '--surface', card], ['--done', '--surface', card],
    ['--game-gold', '--surface', card], ['--game-gold', '--raised', raised],
    ...['--hue-training', '--hue-learning', '--hue-research', '--hue-tasks', '--hue-health', '--hue-weather', '--hue-markets']
      .map((hue): [string, string, string] => [hue, '--surface', card]),
  ];

  it.each(pairs)('%s on %s', (fg, _label, background) => {
    expect(contrast(resolve(fg), background)).toBeGreaterThanOrEqual(4.5);
  });

  it('dark text on a filled accent button', () => {
    expect(contrast(bg, resolve('--accent'))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(bg, resolve('--accent-on-raised'))).toBeGreaterThanOrEqual(4.5);
  });

  it('sheets swap in the raised-surface accent and muted colours', () => {
    const sheet = block('.sheet');
    expect(sheet.get('--accent')).toBe('var(--accent-on-raised)');
    expect(sheet.get('--muted')).toBe('var(--muted-on-raised)');
  });

  it('the card values would fail on the raised grey (why the sheet swap exists)', () => {
    expect(contrast(resolve('--ios-blue'), raised)).toBeLessThan(4.5);
  });
});
