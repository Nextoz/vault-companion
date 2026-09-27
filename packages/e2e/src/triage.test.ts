import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { Desktop } from './desktop.ts';
import { createRemote, logWithOps } from './git.ts';
import { Phone } from './phone.ts';
import { startServer, type HarnessServer } from './server.ts';

it('phone decision → desktop pull: one appended line, byte-identical prefix and exactly one operation commit', async () => {
  const path = 'Events/Triage/Decisions/2026-10.jsonl';
  const prefix = '\uFEFF{"legacy":"synthetic ø 🌱"}\r\nmalformed final line';
  const remote = createRemote({ [path]: prefix });
  let server: HarnessServer | undefined;
  try {
    server = await startServer({ bare: remote.bare, gitEnv: remote.env, now: () => new Date('2026-09-30T22:30:00Z'), timeZone: 'Europe/Copenhagen' });
    const phone = await Phone.signIn(server.baseUrl, await server.token(), '2026-09-30T22:30:00Z');
    const desktop = Desktop.clone(remote.env, remote.bare, join(remote.root, 'desktop'));
    const initial = await phone.triage();
    const cmd = phone.envelope('TriageDecide', { eventId: '0a1b2c3d4e5f60718293', decision: 'go', reason: null, undoes: null, explore: false,
      card: { title: 'Evening talk on city gardens', category: 'community', sourceName: 'Example source', aiScore: 88, start: '2026-10-02T17:00:00+02:00' } }, initial.revision);
    expect(await phone.send(cmd)).toMatchObject({ receipt: { status: 'applied', path, effect: { kind: 'triage-decided', decisionId: cmd.operationId } } });
    expect(await phone.send(cmd)).toMatchObject({ receipt: { status: 'already-applied' } });
    expect(desktop.sync().integrated).toBe('fast-forward');
    const bytes = readFileSync(join(desktop.dir, path));
    expect(bytes.subarray(0, Buffer.byteLength(prefix))).toEqual(Buffer.from(prefix));
    const appended = bytes.subarray(Buffer.byteLength(prefix)).toString('utf8');
    expect(appended.startsWith('\n')).toBe(true);
    expect(appended.endsWith('\n')).toBe(true);
    const lines = appended.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({ schemaVersion: 1, decisionId: cmd.operationId, ...cmd.payload, at: cmd.occurredAt });
    expect((await phone.triage()).decisions).toMatchObject([{ decisionId: cmd.operationId, decision: 'go' }]);
    expect(logWithOps(remote.env, remote.bare).filter((c) => c.operationId === cmd.operationId)).toHaveLength(1);
    expect(JSON.stringify(server.logs)).not.toContain(cmd.payload.card.title);
  } finally {
    await server?.close();
    rmSync(remote.root, { recursive: true, force: true });
  }
}, 60_000);
