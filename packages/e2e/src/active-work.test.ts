import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { Desktop } from './desktop.ts';
import { createRemote, logWithOps } from './git.ts';
import { Phone } from './phone.ts';
import { startServer, type HarnessServer } from './server.ts';

it('phone capture + review done → desktop pull: exact bytes and one commit each', async () => {
  const path = 'Tasks/Active Work Now.md';
  const fixture = '\uFEFF' + readFileSync(new URL('../../vault-markdown/src/fixtures/active-work.md', import.meta.url), 'utf8').replaceAll('\r\n', '\n').replaceAll('\n', '\r\n');
  const remote = createRemote({ [path]: fixture });
  let server: HarnessServer | undefined;
  try {
    server = await startServer({ bare: remote.bare, gitEnv: remote.env, now: () => new Date('2026-09-27T10:00:00Z'), timeZone: 'Europe/Copenhagen' });
    const phone = await Phone.signIn(server.baseUrl, await server.token(), '2026-09-27T12:00:00+02:00');
    const desktop = Desktop.clone(remote.env, remote.bare, join(remote.root, 'desktop'));
    const initial = await phone.activeWork();
    const capture = phone.envelope('CaptureActiveWork', { name: 'New project', next: 'first step', review: '2026-10-04' }, initial.revision);
    const saved = await phone.send(capture);
    expect(saved).toMatchObject({ receipt: { status: 'applied', effect: { op: 'captured' } } });
    expect(await phone.send(capture)).toMatchObject({ receipt: { status: 'already-applied' } });
    const line = '- [ ] **New project:** Next: first step ⏳ 2026-10-04';
    const captured = fixture.replace('\r\n\r\nProse paragraph', `\r\n${line}\r\n\r\nProse paragraph`);
    expect(desktop.sync().integrated).toBe('fast-forward');
    expect(desktop.read(path)).toBe(captured);
    const read = await phone.activeWork();
    const review = phone.envelope('ReviewActiveWork', { item: read.items.find((i) => i.name === 'New project')!.locator, action: 'done' }, read.revision);
    expect(await phone.send(review)).toMatchObject({ receipt: { status: 'applied', effect: { op: 'done' } } });
    expect(await phone.send(review)).toMatchObject({ receipt: { status: 'already-applied' } });
    const old = '- 2026-09-18: an older prose entry about something stopped. [[Archive/Old]]';
    const expected = fixture.replace(old, `${old}\r\n${line.replace('[ ]', '[x]')} ✅ 2026-09-27`);
    expect(desktop.sync().integrated).toBe('fast-forward');
    expect(readFileSync(join(desktop.dir, path))).toEqual(Buffer.from(expected));
    const commits = logWithOps(remote.env, remote.bare);
    for (const cmd of [capture, review]) expect(commits.filter((c) => c.operationId === cmd.operationId)).toHaveLength(1);
    expect(JSON.stringify(server.logs)).not.toContain('New project');
  } finally {
    await server?.close();
    rmSync(remote.root, { recursive: true, force: true });
  }
}, 60_000);
