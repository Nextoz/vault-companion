// Redesign R1 (review #5, #6): component CSS names a token, never a raw value. Every `font-size` and `border-radius`
// declaration in apps/web CSS (tokens.css excepted) must be `inherit`, `0`, `50%`, or use defined `var(--…)` tokens. The
// few intentional exceptions are listed in ALLOWED by exact `file:selector`, each with the reason it is not a token.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const webDir = fileURLToPath(new URL('..', import.meta.url));
// Token names tokens.css defines: a typo such as var(--t-subheading) is invalid at computed time and silently inherits.
const defined = new Set([...readFileSync(new URL('./tokens.css', import.meta.url), 'utf8').matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));

/** Every var() names a defined token and carries no raw fallback (var(--x, 13px) would hide a raw value). */
function tokensOnly(value: string): boolean {
  const refs = [...value.matchAll(/var\(\s*(--[\w-]+)\s*([,)])/g)];
  return refs.length > 0 && refs.every((m) => defined.has(m[1] ?? '') && m[2] === ')');
}

const ALLOWED: Record<string, string> = {
  // The root size every rem token is relative to (1rem = 17 px); a Dynamic Type `font:` override follows it.
  'src/styles.css::root': 'root font size: the base all --t-* rem tokens scale from',
  // The level-up number is deliberately larger than --t-display.
  'src/ui/Rewards.css:.reward-level-number': 'level-up stamp, larger than --t-display by design',
};

function cssFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules' || entry.name === 'dist') return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return cssFiles(path);
    return entry.name.endsWith('.css') && entry.name !== 'tokens.css' ? [path] : [];
  });
}

interface Offence { where: string; text: string }

// Walks the stylesheet keeping a selector stack, so a declaration is reported as file:line with its selector.
function scan(file: string): Offence[] {
  const rel = relative(webDir, file).replaceAll('\\', '/');
  const source = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
  const offences: Offence[] = [];
  const stack: string[] = [];
  let buffer = '';
  let line = 1;
  let startLine = 1;
  for (const ch of source) {
    if (ch === '\n') line++;
    if (ch === '{') {
      stack.push(buffer.trim().replace(/\s+/g, ' '));
      buffer = '';
      startLine = line;
    } else if (ch === '}' || ch === ';') {
      const decl = /^([\w-]+)\s*:\s*([\s\S]+)$/.exec(buffer.trim());
      if (decl && (decl[1] === 'font-size' || decl[1] === 'border-radius')) {
        const value = (decl[2] ?? '').trim();
        const selector = stack[stack.length - 1] ?? '';
        const ok = ['inherit', '0', '50%'].includes(value) || tokensOnly(value) || `${rel}:${selector}` in ALLOWED;
        if (!ok) offences.push({ where: `${rel}:${startLine}`, text: `${selector} { ${decl[1]}: ${value} }` });
      }
      buffer = '';
      if (ch === '}') stack.pop();
      startLine = line;
    } else {
      if (buffer.trim() === '') startLine = line;
      buffer += ch;
    }
  }
  return offences;
}

describe('component CSS names tokens', () => {
  const files = cssFiles(webDir);

  it('finds the stylesheets', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it('every font-size and border-radius is inherit, 0, 50% or a var(--token), bar the allowlist', () => {
    const offences = files.flatMap(scan).map((o) => `${o.where}  ${o.text}`);
    expect(offences, `raw values (use a --t-* / --r-* token from tokens.css):\n${offences.join('\n')}`).toEqual([]);
  });
});
