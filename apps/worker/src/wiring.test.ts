// Review A10/R10: prove the real wiring, not stubs. (1) A18 sentinel through createApp + createCommandService +
// kernel + InMemoryStore for every command, refusals and an outage. (2) The production composition accepts a
// correctly signed Access token and rejects others. (3) configProblems covers R11.
import { Command } from '@vault-companion/contracts';
import { createCommandService } from '@vault-companion/domain';
import { InMemoryStore } from '@vault-companion/domain/testing';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
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

describe('A18 through the real command stack (review A10/R10)', () => {
  it('no command, refusal or outage logs task text, note text or a clear-text path', async () => {
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
    expect(logs.find((l) => l.commandType === 'CaptureNote')?.pathHash).toMatch(/^[0-9a-f]{16}$/);
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
