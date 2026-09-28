import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { Desktop } from './desktop.ts';
import { createRemote, logWithOps } from './git.ts';
import { Phone } from './phone.ts';
import { startServer, type HarnessServer } from './server.ts';

it('phone logs exactly one row; desktop pull preserves every other byte; Undo restores the original', async () => {
  const path = 'Health/Training Log.md';
  const fixture = '\uFEFF---\r\nprivate: synthetic\r\n---\r\n## Sessions\r\n| Date | Time | Type | Distance | Duration | Weight | Split | Note |\r\n| --- | --- | --- | --- | --- | --- | --- | --- |\r\n| 2026-09-25 | | Group workout | | | | | |\r\n| unknown |  keep spacing |\r\n\r\n## Week summaries\r\nWorth keeping… exact bytes  \r\n';
  const remote = createRemote({ [path]: fixture });
  let server: HarnessServer | undefined;
  try {
    server = await startServer({ bare: remote.bare, gitEnv: remote.env, now: () => new Date('2026-09-28T16:42:00Z'), timeZone: 'Europe/Copenhagen' });
    const phone = await Phone.signIn(server.baseUrl, await server.token(), '2026-09-28T18:42:00+02:00');
    const desktop = Desktop.clone(remote.env, remote.bare, join(remote.root, 'desktop'));
    const initial = await phone.training();
    const target = phone.envelope('LogTraining', { session: { type: 'Run', when: '2026-09-28T18:42:00+02:00', distance: 5.2, duration: 28, note: 'Easy | loop\nagain' } }, initial.revision);
    const saved = await phone.send(target);
    expect(saved).toMatchObject({ receipt: { status: 'applied', effect: { op: 'logged' } } });
    if (!('receipt' in saved)) throw new Error('save failed');
    expect(await phone.send(target)).toMatchObject({ receipt: { status: 'already-applied' } });
    const line = '| 2026-09-28 | 18:42 | Run | 5.2 km | 28 min | | | Easy \\| loop again |';
    expect(desktop.sync().integrated).toBe('fast-forward');
    const bytes = readFileSync(join(desktop.dir, path));
    expect(bytes).toEqual(Buffer.from(fixture.replace('| 2026-09-25', line + '\r\n| 2026-09-25')));
    expect(bytes.toString().replace(line + '\r\n', '')).toBe(fixture);
    expect((await phone.training()).rows).toHaveLength(2);
    const undo = phone.envelope('UndoLogTraining', { target, targetCommit: saved.receipt.commitSha }, saved.receipt.commitSha);
    expect(await phone.send(undo)).toMatchObject({ receipt: { status: 'applied', effect: { op: 'undone' } } });
    expect(await phone.send(undo)).toMatchObject({ receipt: { status: 'already-applied' } });
    expect(desktop.sync().integrated).toBe('fast-forward');
    expect(readFileSync(join(desktop.dir, path))).toEqual(Buffer.from(fixture));
    const commits = logWithOps(remote.env, remote.bare);
    for (const cmd of [target, undo]) expect(commits.filter((c) => c.operationId === cmd.operationId)).toHaveLength(1);
    expect(JSON.stringify(server.logs)).not.toContain('Easy');
  } finally {
    await server?.close();
    rmSync(remote.root, { recursive: true, force: true });
  }
}, 60_000);
