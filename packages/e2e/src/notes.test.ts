// ADR-0022 over real Git: the phone edits an Inbox note → the desktop pull shows the exact bytes, frontmatter intact.
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { Desktop } from './desktop.ts';
import { createRemote, logWithOps } from './git.ts';
import { Phone } from './phone.ts';
import { startServer, type HarnessServer } from './server.ts';

it('phone edits a note body → desktop pull: exact bytes (BOM, CRLF frontmatter kept), one commit, replay safe', async () => {
  const path = 'Inbox/Seed order - 2026-09-26.md';
  const bom = String.fromCharCode(0xfeff);
  const frontmatter = '---\r\ndate: 2026-09-26\r\ntype: inbox-note\r\nstatus: open\r\n---\r\n';
  const remote = createRemote({ [path]: `${bom}${frontmatter}Tomatoes and basil.\r\n`, 'Inbox/Archive/Old - 2026-01-01.md': 'nested\n' });
  let server: HarnessServer | undefined;
  try {
    server = await startServer({ bare: remote.bare, gitEnv: remote.env, now: () => new Date('2026-09-27T10:00:00Z'), timeZone: 'Europe/Copenhagen' });
    const phone = await Phone.signIn(server.baseUrl, await server.token(), '2026-09-27T12:00:00+02:00');
    const desktop = Desktop.clone(remote.env, remote.bare, join(remote.root, 'desktop'));

    const list = await phone.notes();
    expect(list.notes.map((n) => [n.path, n.title, n.date])).toEqual([[path, 'Seed order', '2026-09-26']]);
    const read = await phone.note(path);
    expect(read).toMatchObject({ frontmatter: frontmatter, body: 'Tomatoes and basil.\r\n', blobSha: list.notes[0]!.blobSha });

    // The editor types LF; the file keeps CRLF, its BOM and its frontmatter byte for byte.
    const edit = phone.envelope('EditNote', { note: { path, blobSha: read.blobSha }, body: 'Tomatoes, basil\nand chives.\n' }, read.revision);
    expect(await phone.send(edit)).toMatchObject({ receipt: { status: 'applied', path, effect: { kind: 'note-edited', path } } });
    expect(await phone.send(edit)).toMatchObject({ receipt: { status: 'already-applied' } });
    expect(desktop.sync().integrated).toBe('fast-forward');
    expect(readFileSync(join(desktop.dir, path))).toEqual(Buffer.from(`${bom}${frontmatter}Tomatoes, basil\r\nand chives.\r\n`));

    // A stale read (the note changed since) is a visible conflict, never an overwrite.
    const stale = phone.envelope('EditNote', { note: { path, blobSha: read.blobSha }, body: 'Overwrite?' }, read.revision);
    expect(await phone.send(stale)).toMatchObject({ status: 409, error: { code: 'conflict:task-changed' } });

    expect(logWithOps(remote.env, remote.bare).filter((c) => c.operationId === edit.operationId)).toHaveLength(1);
    expect(JSON.stringify(server.logs)).not.toContain('chives');
    expect(JSON.stringify(server.logs)).not.toContain('Seed order');
  } finally {
    await server?.close();
    rmSync(remote.root, { recursive: true, force: true });
  }
}, 60_000);
