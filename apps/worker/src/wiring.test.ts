// Review A10/R10: prove the real wiring, not stubs. (1) A18 sentinel through createApp + createCommandService +
// kernel + InMemoryStore for every command, refusals and an outage. (2) The production composition accepts a
// correctly signed Access token and rejects others. (3) configProblems covers R11.
import { Command, MAX_TASK_LINE, Receipt, TasksResponse } from '@vault-companion/contracts';
import { createCommandService } from '@vault-companion/domain';
import { InMemoryStore } from '@vault-companion/domain/testing';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from './app.ts';
import { configProblems, createProductionApp, type Env } from './index.ts';
import type { LogRecord } from './log.ts';

const SENTINEL = 'SENTINEL-9c1e';
const ORIGIN = 'https://vc.example.com';
const ACCOUNT = 'a'.repeat(64);
const TODO = 'Tasks/To-Do List.md';
const SEED =
  '## Open\n\n' +
  `- [ ] Water the ${SENTINEL} plants #todo\n` +
  `- [ ] Take out the ${SENTINEL} recycling #todo 🔁 every week\n` +
  '\n## Done\n\n- [x] Old #todo ✅ 2026-09-01\n';

afterEach(() => vi.restoreAllMocks());

describe('A18 through the real command stack (review A10/R10)', () => {
  it('no command, refusal or outage logs task text, note text or a clear-text path', async () => {
    // Rerun review Astra N4: also watch the console, so a stray console.* in any layer cannot leak unnoticed.
    const printed: unknown[][] = [];
    for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void printed.push(a));
    const store = await InMemoryStore.create({ [TODO]: SEED });
    const services = createCommandService({ store, now: () => new Date('2026-09-24T12:00:00Z'), timeZone: 'Europe/Copenhagen' });
    const logs: LogRecord[] = [];
    const app = createApp({
      verify: async () => ({ ok: true, email: 'owner@example.com', accountKey: ACCOUNT }),
      appOrigin: ORIGIN,
      services,
      log: (r) => logs.push(r),
    });
    const base = store.headCommit;
    let n = 0;
    const env = (type: string, payload: unknown) => ({
      schemaVersion: 1,
      operationId: `00000000-0000-4000-a000-${(++n).toString(16).padStart(12, '0')}`,
      type,
      occurredAt: '2026-09-24T14:00:00+02:00',
      baseRevision: base,
      payload,
    });
    const post = (body: unknown) =>
      app.request('/api/commands', {
        method: 'POST',
        headers: { Origin: ORIGIN, 'X-VC-Request': '1', 'X-VC-Account': ACCOUNT, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    const tasks = await (await app.request('/api/tasks')).json();
    const water = tasks.allOpen.find((t: { description: string }) => t.description.includes('Water'));
    const recycling = tasks.allOpen.find((t: { description: string }) => t.description.includes('recycling'));

    const complete = env('CompleteTask', { task: water.locator });
    Command.parse(complete);
    const statuses = [
      (await post(complete)).status,
      (await post(env('UndoCompleteTask', { target: complete }))).status,
      (await post(env('CaptureTask', { text: `Call ${SENTINEL} about the bike` }))).status,
      (await post(env('CaptureNote', { text: `${SENTINEL} first line\nand ${SENTINEL} body` }))).status,
      (await post(env('CompleteTask', { task: recycling.locator }))).status, // refused:recurring
    ];
    store.writeFaults.push('unavailable');
    statuses.push((await post(env('CaptureTask', { text: `Outage ${SENTINEL}` }))).status);

    expect(statuses).toEqual([200, 200, 200, 200, 422, 503]);
    expect(logs.length).toBeGreaterThanOrEqual(7);
    expect(JSON.stringify(logs)).not.toContain(SENTINEL);
    expect(JSON.stringify(logs)).not.toContain('Inbox/');
    expect(JSON.stringify(printed)).not.toContain(SENTINEL);
    expect(logs.find((l) => l.commandType === 'CaptureNote')?.pathHash).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('accepted results are closed under the public contracts (gate-3 G3-3)', () => {
  async function stack(todo: string) {
    const store = await InMemoryStore.create({ [TODO]: todo });
    const services = createCommandService({ store, now: () => new Date('2026-09-24T12:00:00Z'), timeZone: 'Europe/Copenhagen' });
    const app = createApp({ verify: async () => ({ ok: true, email: 'o@example.com', accountKey: ACCOUNT }), appOrigin: ORIGIN, services, log: () => {} });
    let n = 0;
    const env = (type: string, payload: unknown) => ({
      schemaVersion: 1,
      operationId: `00000000-0000-4000-b000-${(++n).toString(16).padStart(12, '0')}`,
      type,
      occurredAt: '2026-09-24T14:00:00+02:00',
      baseRevision: store.headCommit,
      payload,
    });
    const post = async (body: unknown) => {
      const res = await app.request('/api/commands', {
        method: 'POST',
        headers: { Origin: ORIGIN, 'X-VC-Request': '1', 'X-VC-Account': ACCOUNT, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: await res.json() };
    };
    const read = async () => TasksResponse.parse(await (await app.request('/api/tasks')).json());
    return { store, env, post, read };
  }

  it('Astra repro 1: maximal capture (2,000 text + 2,000-char URL context) yields a valid receipt and valid reads, retry included', async () => {
    const { env, post, read } = await stack('## Open\n\n## Done\n');
    const context = `https://example.com/${'a'.repeat(2000 - 20)}`;
    const cmd = env('CaptureTask', { text: 'x'.repeat(2000), context });
    const first = await post(cmd);
    expect(first.status).toBe(200);
    expect(Receipt.safeParse(first.body).success).toBe(true);
    const again = await post(cmd); // deduplicated retry
    expect(Receipt.safeParse(again.body).success).toBe(true);
    expect((await read()).allOpen).toHaveLength(1);
  });

  it('Astra repro 2 (scaled to the new limit): completing a line near the limit is refused before writing, and reads stay valid', async () => {
    const long = `- [ ] ${'y'.repeat(MAX_TASK_LINE - 12)} #todo`; // exactly MAX_TASK_LINE characters
    expect(long.length).toBe(MAX_TASK_LINE);
    const { store, env, post, read } = await stack(`## Open\n\n${long}\n\n## Done\n`);
    const view = await read();
    const head = store.headCommit;
    const res = await post(env('CompleteTask', { task: view.allOpen[0]!.locator }));
    expect(res).toMatchObject({ status: 400, body: { code: 'invalid' } });
    expect(store.headCommit).toBe(head);
  });

  it('an existing line over the limit does not invalidate the task list: it is omitted and counted', async () => {
    const huge = `- [ ] ${'z'.repeat(MAX_TASK_LINE + 10)} #todo`;
    const { read } = await stack(`## Open\n\n- [ ] Normal #todo\n${huge}\n\n## Done\n`);
    const view = await read();
    expect(view.allOpen.map((t) => t.description)).toEqual(['Normal']);
    expect(view.omittedLongLines).toBe(1);
  });
});

describe('unexpected service failure (rerun review Opus N4)', () => {
  it('answers 503 upstream-unavailable, retryable, without detail', async () => {
    const app = createApp({
      verify: async () => ({ ok: true, email: 'owner@example.com', accountKey: ACCOUNT }),
      appOrigin: ORIGIN,
      services: {
        readTasks: async () => {
          throw new Error(`boom ${SENTINEL}`);
        },
        execute: async () => {
          throw new Error('boom');
        },
      },
      log: () => {},
    });
    const res = await app.request('/api/tasks');
    expect(res.status).toBe(503);
    const body = await res.text();
    expect(JSON.parse(body)).toEqual({ code: 'upstream-unavailable', message: 'internal error', retryable: true });
    expect(body).not.toContain(SENTINEL);
  });
});

describe('production composition (review R10)', () => {
  const env: Env = {
    AUTH_MODE: 'access',
    ACCESS_TEAM_DOMAIN: 'https://team.cloudflareaccess.com',
    ACCESS_AUD: 'aud-1',
    ALLOWED_EMAILS: 'owner@example.com',
    APP_ORIGIN: ORIGIN,
    GITHUB_APP_ID: '1',
    GITHUB_APP_PRIVATE_KEY: 'unused-in-this-test',
    GITHUB_INSTALLATION_ID: '2',
    VAULT_OWNER: 'o',
    VAULT_REPO: 'r',
  };

  it('accepts a valid Access token via the real verifier wiring and derives the account key', async () => {
    const kp = await generateKeyPair('RS256', { extractable: true });
    const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(kp.publicKey)), kid: 'k', alg: 'RS256' }] });
    const app = createProductionApp(env, keys);
    const token = await new SignJWT({ email: 'owner@example.com' })
      .setProtectedHeader({ alg: 'RS256', kid: 'k' })
      .setIssuer('https://team.cloudflareaccess.com')
      .setAudience('aud-1')
      .setSubject('user-1')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(kp.privateKey);
    const good = await app.fetch(new Request(`${ORIGIN}/api/session`, { headers: { 'Cf-Access-Jwt-Assertion': token } }));
    expect(good.status).toBe(200);
    expect((await good.json()).accountKey).toMatch(/^[0-9a-f]{64}$/);
    // The linked-note route is composed in production: a malformed request is a 400 from the route, not the 404 an
    // unwired service gives (P4-A handoff).
    const note = await app.fetch(new Request(`${ORIGIN}/api/linked-note`, { headers: { 'Cf-Access-Jwt-Assertion': token } }));
    expect(note.status).toBe(400);
    const other = await new SignJWT({ email: 'owner@example.com' })
      .setProtectedHeader({ alg: 'RS256', kid: 'k' })
      .setIssuer('https://team.cloudflareaccess.com')
      .setAudience('another-app')
      .setSubject('user-1')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(kp.privateKey);
    const bad = await app.fetch(new Request(`${ORIGIN}/api/session`, { headers: { 'Cf-Access-Jwt-Assertion': other } }));
    expect(bad.status).toBe(401);
  });

  it.each([
    ['invalid time zone', { USER_TIME_ZONE: 'Europe/Copenhagn' }],
    ['http team domain', { ACCESS_TEAM_DOMAIN: 'http://team.cloudflareaccess.com' }],
  ])('configProblems rejects %s (review R11)', (_n, over) => {
    expect(configProblems({ ...env, ...over }).length).toBeGreaterThan(0);
  });
});
