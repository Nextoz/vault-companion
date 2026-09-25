import { describe, expect, it } from 'vitest';
import raw from '../wrangler.jsonc?raw';
import { configProblems } from './index.ts';

/** JSONC → JSON: drops comments and trailing commas outside strings. */
function stripJsonc(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (ch === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2) + 1;
      if (i === 0) throw new Error('unterminated block comment');
    } else if (ch === ',' && /^\s*[}\]]/.test(text.slice(i + 1))) {
      // trailing comma
    } else {
      out += ch;
    }
  }
  return out;
}

interface WranglerConfig {
  vars?: Record<string, string>;
  secrets?: { required?: string[] };
  assets?: { directory?: string; run_worker_first?: boolean | string[] };
}

const config = JSON.parse(stripJsonc(raw)) as WranglerConfig;
const vars = config.vars ?? {};
const secrets = config.secrets?.required ?? [];
// REQUIRED is private to index.ts; configProblems reports exactly those names as "missing X" for an empty env.
const required = configProblems({ AUTH_MODE: 'access' }).map((p) => /^missing (\w+)$/.exec(p)?.[1]).filter((k) => k !== undefined);

describe('wrangler.jsonc', () => {
  it('declares every required setting as a var or a secret', () => {
    expect(required.length).toBeGreaterThan(0);
    const undeclared = required.filter((k) => !(k in vars) && !secrets.includes(k));
    expect(undeclared).toEqual([]);
  });

  it('pins production auth to Cloudflare Access', () => {
    expect(vars['AUTH_MODE']).toBe('access');
  });

  it('commits only non-identifying vars (public repo); everything else is a secret', () => {
    expect(Object.keys(vars).sort()).toEqual(['AUTH_MODE', 'USER_TIME_ZONE', 'VAULT_BRANCH']);
    expect(required.filter((k) => !secrets.includes(k))).toEqual([]);
  });

  it('never gives a secret a committed value', () => {
    expect(secrets.filter((k) => k in vars)).toEqual([]);
  });

  it('passes the committed vars through the production guard', () => {
    expect(configProblems(vars).filter((p) => !p.startsWith('missing '))).toEqual([]);
  });

  it('routes /api/* to the Worker and serves the web build from the same origin', () => {
    expect(config.assets?.directory).toBe('../web/dist');
    expect(config.assets?.run_worker_first).toEqual(['/api/*']);
  });
});
