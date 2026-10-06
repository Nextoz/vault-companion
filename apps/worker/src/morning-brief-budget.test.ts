// ADR-0055 reproduction: one Morning Brief cron invocation on Workers Free must stay inside the 50-subrequest limit
// (and the code's own 45 budget) with a realistic vault, Google mail/calendar, Scaleway and weather all available.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exportPKCS8, generateKeyPair } from 'jose';
import { runScheduled, type Env } from './index.ts';

const HEAD = '1'.repeat(40);
const TODO = 'Tasks/To-Do List.md';
const TRAINING = 'Health/Training Log.md';
const HEALTH = 'Health/Data/Apple Health Daily.csv';
const DAILY_TODAY = 'Journal/Daily/2026-10-04.md';
const DAILY_YESTERDAY = 'Journal/Daily/2026-10-03.md';

const dailyMood = (date: string, checkinAt: string): string =>
  ['---', `date: ${date}`, 'mood: -1', 'energy: 1', 'sleep: 7', `checkin_at: ${checkinAt}`, '---', '', 'Synthetic body', ''].join('\n');

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

const sha40 = (value: string): string => {
  const hex = '0123456789abcdef';
  let out = '';
  for (let i = 0; i < 40; i++) {
    const code = value.charCodeAt(i % Math.max(1, value.length)) ?? 0;
    out += hex[(value.length * 31 + i * 7 + code) % 16]!;
  }
  return out;
};

function createFakeFetch(files: Record<string, string>) {
  const calls: { kind: string; method: string; url: string }[] = [];

  const directEntries = (dir: string) => {
    const entries = new Map<string, { path: string; mode: string; type: string; sha: string }>();
    const prefix = dir === '' ? '' : `${dir}/`;
    for (const [path, content] of Object.entries(files)) {
      if (!path.startsWith(prefix)) continue;
      const rel = path.slice(prefix.length);
      const first = rel.split('/')[0]!;
      if (rel.includes('/')) {
        entries.set(first, { path: first, mode: '040000', type: 'tree', sha: sha40(`dir:${dir}/${first}`) });
      } else {
        entries.set(first, { path: first, mode: '100644', type: 'blob', sha: sha40(content) });
      }
    }
    return [...entries.values()];
  };

  const weatherBody = () => {
    const start = Math.floor(Date.now() / 3_600_000) * 3_600;
    const time = Array.from({ length: 48 }, (_, i) => start + i * 3_600);
    return {
      utc_offset_seconds: 0,
      hourly_units: { time: 'unixtime', temperature_2m: '°C', rain: 'mm', wind_speed_10m: 'm/s' },
      hourly: {
        time,
        temperature_2m: time.map(() => 15),
        rain: time.map(() => 0),
        wind_speed_10m: time.map(() => 2),
      },
    };
  };

  const fetchImpl: typeof fetch = (async (input, init) => {
    const url = new URL(String(input));
    const method = String(init?.method ?? 'GET').toUpperCase();
    calls.push({ kind: 'other', method, url: url.href });
    const call = calls.at(-1)!;

    if (url.hostname === 'api.github.com') {
      if (url.pathname === '/app/installations/1/access_tokens') {
        call.kind = 'github-token';
        return json(201, { token: 'ghs_synthetic', expires_at: new Date(Date.now() + 3_600_000).toISOString() });
      }
      const base = '/repos/o/r';
      if (!url.pathname.startsWith(base)) return json(404, { message: 'not found' });
      const path = url.pathname.slice(base.length);
      if (method === 'GET' && path === '/git/ref/heads/main') {
        call.kind = 'github-head';
        return json(200, { object: { sha: HEAD } });
      }
      if (method === 'GET' && path.startsWith('/git/commits/')) {
        call.kind = 'github-commit';
        return json(200, { sha: HEAD, tree: { sha: sha40('root-tree') }, parents: [], committer: { date: new Date().toISOString() }, message: 'seed' });
      }
      if (method === 'GET' && path.startsWith('/git/trees/')) {
        call.kind = 'github-tree';
        const suffix = path.slice('/git/trees/'.length);
        const colon = suffix.indexOf(':');
        const dir = colon < 0 ? '' : decodeURIComponent(suffix.slice(colon + 1));
        const tree = directEntries(dir);
        if (tree.length === 0) return json(404, { message: 'Not Found' });
        return json(200, { sha: sha40(`tree:${dir}`), truncated: false, tree });
      }
      if (method === 'GET' && path.startsWith('/contents/')) {
        call.kind = 'github-contents';
        const rel = path.slice('/contents/'.length).split('/').map((segment) => decodeURIComponent(segment)).join('/');
        const content = files[rel];
        if (content === undefined) return json(404, { message: 'Not Found' });
        return json(200, { type: 'file', sha: sha40(content), size: content.length, encoding: 'base64', content: btoa(content) });
      }
      if (method === 'POST' && path === '/git/blobs') {
        call.kind = 'github-write';
        return json(201, { sha: 'b'.repeat(40) });
      }
      if (method === 'POST' && path === '/git/trees') {
        call.kind = 'github-write';
        return json(201, { sha: 'c'.repeat(40) });
      }
      if (method === 'POST' && path === '/git/commits') {
        call.kind = 'github-write';
        return json(201, { sha: 'd'.repeat(40) });
      }
      if (method === 'PATCH' && path.startsWith('/git/refs/heads/')) {
        call.kind = 'github-write';
        return json(200, { object: { sha: 'd'.repeat(40) } });
      }
      return json(404, { message: `unexpected github ${method} ${path}` });
    }

    if (url.hostname === 'oauth2.googleapis.com') {
      call.kind = 'google-token';
      return json(200, {
        access_token: 'synthetic-access-token',
        scope: 'https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/gmail.metadata',
      });
    }
    if (url.hostname === 'www.googleapis.com') {
      if (url.pathname === '/calendar/v3/calendars/primary/events') {
        call.kind = 'google-calendar';
        return json(200, { items: [] });
      }
      return json(404, { message: 'not found' });
    }
    if (url.hostname === 'gmail.googleapis.com') {
      if (url.pathname === '/gmail/v1/users/me/labels') {
        call.kind = 'google-labels';
        return json(200, {
          labels: [
            { id: 'label-deadline', name: 'Jev/Deadline' },
            { id: 'label-payment', name: 'Jev/Payment' },
            { id: 'label-reply', name: 'Jev/Needs reply' },
          ],
        });
      }
      if (url.pathname === '/gmail/v1/users/me/messages') {
        call.kind = 'google-mail-list';
        return json(200, { messages: Array.from({ length: 10 }, (_, i) => ({ id: `msg-${i}` })) });
      }
      if (/^\/gmail\/v1\/users\/me\/messages\/[^/]+$/.test(url.pathname)) {
        call.kind = 'google-mail-read';
        return json(200, {
          payload: {
            headers: [
              { name: 'From', value: 'Alice Example <alice@example.com>' },
              { name: 'Subject', value: 'Synthetic subject' },
              { name: 'Date', value: '2026-10-04T06:00:00Z' },
              { name: 'List-Unsubscribe', value: '' },
            ],
          },
        });
      }
      return json(404, { message: 'not found' });
    }
    if (url.hostname === 'api.open-meteo.com') {
      call.kind = 'weather';
      return json(200, weatherBody());
    }
    if (url.hostname === 'api.scaleway.ai') {
      call.kind = 'scaleway';
      return json(200, {
        choices: [{ message: { content: JSON.stringify({ dayLine: 'A synthetic day.', gaps: [], todos: [], encouragement: 'Synthetic.' }) } }],
      });
    }
    return json(404, { message: `unexpected ${url.href}` });
  }) as typeof fetch;

  return { fetch: fetchImpl, calls };
}

describe('Morning Brief cron subrequest budget (ADR-0055)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // 2026-10-04 04:31 UTC is 06:31 Europe/Copenhagen (summer), the primary 31 4 slot.
    vi.setSystemTime(new Date('2026-10-04T04:31:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('finishes the full gather scenario within 45 subrequests', async () => {
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    const files: Record<string, string> = {
      [TODO]: '## Open\n\n- [ ] Synthetic task one #todo\n\n## Done\n',
      [TRAINING]: '## Sessions\n| Date | Time | Type | Distance | Duration | Weight | Split | Note |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n',
      [HEALTH]: 'date,steps,headphone_min,first_move,last_move\n',
      [DAILY_TODAY]: dailyMood('2026-10-04', '2026-10-04T04:15:00.000Z'),
      [DAILY_YESTERDAY]: dailyMood('2026-10-03', '2026-10-03T21:30:00.000Z'),
    };
    for (let i = 0; i < 100; i++) files[`Tasks/Synthetic note ${i}.md`] = '# Synthetic note\n';
    const fake = createFakeFetch(files);
    const env: Env = {
      AUTH_MODE: 'access',
      ACCESS_TEAM_DOMAIN: 'https://example.cloudflareaccess.com',
      ACCESS_AUD: 'synthetic-audience',
      ALLOWED_EMAILS: 'owner@example.com',
      APP_ORIGIN: 'https://app.example.com',
      GITHUB_APP_ID: '1',
      GITHUB_APP_PRIVATE_KEY: await exportPKCS8(privateKey),
      GITHUB_INSTALLATION_ID: '1',
      VAULT_OWNER: 'o',
      VAULT_REPO: 'r',
      VAULT_BRANCH: 'main',
      USER_TIME_ZONE: 'Europe/Copenhagen',
      SCALEWAY_API_KEY: 'synthetic',
      GOOGLE_CLIENT_ID: 'synthetic-client',
      GOOGLE_CLIENT_SECRET: 'synthetic-secret',
      GOOGLE_REFRESH_TOKEN: 'synthetic-refresh',
    };

    await runScheduled('31 4 * * *', env, fake.fetch);

    const counts = Object.fromEntries([...new Set(fake.calls.map((call) => call.kind))].map((kind) => [kind, fake.calls.filter((call) => call.kind === kind).length]));
    console.log('morning-brief subrequests', counts, `total=${fake.calls.length}`);
    expect(fake.calls.length).toBeLessThanOrEqual(45);
    expect(fake.calls.some((call) => call.kind === 'github-write')).toBe(true);
    expect(fake.calls.some((call) => call.kind === 'scaleway')).toBe(true);
    const moodReads = fake.calls.filter((call) => {
      if (call.kind !== 'github-contents') return false;
      const after = call.url.split('/contents/')[1]?.split('?')[0] ?? '';
      const path = after.split('/').map((segment) => decodeURIComponent(segment)).join('/');
      return path === DAILY_TODAY || path === DAILY_YESTERDAY;
    });
    expect(moodReads).toHaveLength(2);
  });
});
