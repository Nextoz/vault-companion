// ADR-0022: Inbox notes — list, read, edit through the real executor. Synthetic vault only.
import { Command, MAX_NOTE_BYTES, MAX_NOTES_LISTED, NoteReadResponse, NotesResponse, type Receipt } from '@vault-companion/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createCommandService } from './commands.ts';
import { createNotesService } from './notes.ts';
import { FileTooLarge, StoreUnavailable, TRAILER_OP } from './store.ts';
import { InMemoryStore } from './testing/in-memory-store.ts';

const NOW = new Date('2026-09-27T12:00:00Z');
const AT = '2026-09-27T14:00:00+02:00';
const BOM = String.fromCharCode(0xfeff);
const FM = '---\ndate: 2026-09-26\ntype: inbox-note\n---\n';
const SEEDS = 'Inbox/Buy seeds - 2026-09-26.md';

let store: InMemoryStore;
let n = 0;
const uuid = () => `00000000-0000-4000-8000-${(++n).toString(16).padStart(12, '0')}`;

beforeEach(async () => {
  store = await InMemoryStore.create({
    'Tasks/To-Do List.md': '## Open\n## Done\n',
    [SEEDS]: `${FM}Tomatoes and basil\n`,
    'Inbox/Call the plumber - 2026-09-27.md': 'Tuesday\n',
    'Inbox/Call the plumber - 2026-09-27 (2).md': 'Wednesday\n',
    'Inbox/Undated idea.md': 'Someday\n',
    'Inbox/Another undated.md': 'Later\n',
    'Inbox/Bad date - 2026-02-30.md': 'x\n',
    'Inbox/Archive/Old - 2026-01-01.md': 'nested\n',
    'Inbox/.hidden.md': 'hidden\n',
    'Inbox/picture.png': 'png',
    'Projects/Plan.md': 'not inbox\n',
  });
});

const notes = () => createNotesService({ store });
const commands = () => createCommandService({ store, now: () => NOW, timeZone: 'Europe/Copenhagen' });

describe('listNotes', () => {
  it('regular .md files directly in Inbox/, newest first by name date, undated after by name', async () => {
    const r = NotesResponse.parse(await notes().listNotes());
    expect(r.revision).toBe(store.headCommit);
    expect(r.notes.map((x) => [x.title, x.date])).toEqual([
      ['Call the plumber', '2026-09-27'],
      ['Call the plumber (2)', '2026-09-27'],
      ['Buy seeds', '2026-09-26'],
      ['Another undated', null],
      ['Bad date - 2026-02-30', null],
      ['Undated idea', null],
    ]);
    expect(r.notes[2]).toEqual({ path: SEEDS, title: 'Buy seeds', date: '2026-09-26', blobSha: expect.stringMatching(/^[0-9a-f]{40}$/) });
    // One listing, no content reads.
    expect(store.calls.filter((c) => c === 'readFile')).toHaveLength(0);
  });

  it('never lists a symlink (the regular-file listing excludes it)', async () => {
    const real = store.listFiles.bind(store);
    vi.spyOn(store, 'listFiles').mockImplementation(async (dir, at) => (await real(dir, at)).filter((f) => f.path !== SEEDS));
    const r = NotesResponse.parse(await notes().listNotes());
    expect(r.notes.map((x) => x.path)).not.toContain(SEEDS);
  });

  it(`caps at ${MAX_NOTES_LISTED}, keeping the newest`, async () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < MAX_NOTES_LISTED + 5; i++) many[`Inbox/N${String(i).padStart(3, '0')} - 2027-01-01.md`] = 'x\n';
    await store.commitFiles(many);
    const r = NotesResponse.parse(await notes().listNotes());
    expect(r.notes).toHaveLength(MAX_NOTES_LISTED);
    expect(r.notes.every((x) => x.date === '2027-01-01')).toBe(true);
  });

  it('truncated listing ⇒ refused:too-large; outage ⇒ upstream-unavailable', async () => {
    vi.spyOn(store, 'listFiles').mockRejectedValueOnce(new FileTooLarge('truncated'));
    expect(await notes().listNotes()).toMatchObject({ code: 'refused:too-large' });
    vi.spyOn(store, 'listFiles').mockRejectedValueOnce(new StoreUnavailable('down'));
    expect(await notes().listNotes()).toMatchObject({ code: 'upstream-unavailable', retryable: true });
  });
});

describe('readNote', () => {
  it('returns the note with its frontmatter/body split', async () => {
    const r = NoteReadResponse.parse(await notes().readNote(SEEDS));
    expect(r).toMatchObject({ status: 'ok', path: SEEDS, markdown: `${FM}Tomatoes and basil\n`, frontmatter: FM, body: 'Tomatoes and basil\n' });
  });

  it('a BOM is not part of markdown, frontmatter or body', async () => {
    await store.commitFiles({ [SEEDS]: `${BOM}${FM}Body\n` });
    expect(await notes().readNote(SEEDS)).toMatchObject({ status: 'ok', markdown: `${FM}Body\n`, frontmatter: FM, body: 'Body\n' });
  });

  it.each([
    ['Inbox/Archive/Old - 2026-01-01.md', 'outside-allowlist'],
    ['Projects/Plan.md', 'outside-allowlist'],
    ['Inbox/../Projects/Plan.md', 'outside-allowlist'],
    ['Inbox/.hidden.md', 'outside-allowlist'],
    ['Inbox/picture.png', 'outside-allowlist'],
    ['Tasks/To-Do List.md', 'outside-allowlist'],
    ['Inbox/Missing.md', 'not-found'],
  ])('%s ⇒ refused %s', async (path, code) => {
    expect(await notes().readNote(path)).toMatchObject({ status: 'refused', code });
  });

  it('a path not in the regular-file listing (symlink) is never read', async () => {
    const real = store.listFiles.bind(store);
    vi.spyOn(store, 'listFiles').mockImplementation(async (dir, at) => (await real(dir, at)).filter((f) => f.path !== SEEDS));
    const read = vi.spyOn(store, 'readFile');
    expect(await notes().readNote(SEEDS)).toMatchObject({ status: 'refused', code: 'not-found' });
    expect(read).not.toHaveBeenCalled();
  });

  it('bytes must be the listed blob; 1 MB and UTF-8 guards', async () => {
    const real = store.readFile.bind(store);
    vi.spyOn(store, 'readFile').mockImplementationOnce(async (p, at) => ({ ...(await real(p, at))!, blobSha: 'f'.repeat(40) }));
    expect(await notes().readNote(SEEDS)).toMatchObject({ status: 'refused', code: 'outside-allowlist' });
    await store.commitFiles({ [SEEDS]: 'a'.repeat(MAX_NOTE_BYTES + 1) });
    expect(await notes().readNote(SEEDS)).toMatchObject({ status: 'refused', code: 'too-large' });
    await store.commitFiles({ [SEEDS]: new Uint8Array([0x61, 0xff, 0x62]) });
    expect(await notes().readNote(SEEDS)).toMatchObject({ status: 'refused', code: 'encoding' });
  });
});

describe('EditNote', () => {
  const edit = async (body: string, over: Partial<{ path: string; blobSha: string; base: string; operationId: string }> = {}) => {
    const read = over.blobSha ? null : NoteReadResponse.parse(await notes().readNote(over.path ?? SEEDS));
    const blobSha = over.blobSha ?? (read!.status === 'ok' ? read!.blobSha : '');
    const raw = {
      schemaVersion: 1, operationId: over.operationId ?? uuid(), type: 'EditNote', occurredAt: AT,
      baseRevision: over.base ?? store.headCommit, payload: { note: { path: over.path ?? SEEDS, blobSha }, body },
    };
    return { raw, result: await commands().execute(Command.parse(raw), raw) };
  };

  it('replaces the body only; exact bytes; receipt effect note-edited; trailers', async () => {
    const { result } = await edit('Tomatoes, basil\nand chives');
    expect(result).toMatchObject({ status: 'applied', path: SEEDS, effect: { kind: 'note-edited', path: SEEDS } });
    expect(store.text(SEEDS)).toBe(`${FM}Tomatoes, basil\nand chives\n`);
    expect(store.commitsWithOp((result as Receipt).operationId)).toHaveLength(1);
    expect(store.commitMessages().at(-1)).toBe('Vault Companion: edit note');
  });

  it('keeps BOM + CRLF frontmatter byte-identical', async () => {
    const fm = '---\r\na: 1\r\n---\r\n';
    await store.commitFiles({ [SEEDS]: `${BOM}${fm}Old\r\n` });
    await edit('New\nlines');
    expect(store.text(SEEDS)).toBe(`${BOM}${fm}New\r\nlines\r\n`);
  });

  it('CAS: the note changed since the read ⇒ conflict:task-changed, nothing written', async () => {
    const r = NoteReadResponse.parse(await notes().readNote(SEEDS));
    const blobSha = r.status === 'ok' ? r.blobSha : '';
    await store.commitFiles({ [SEEDS]: `${FM}Edited on the desktop\n` });
    const writes = store.writeCalls;
    const { result } = await edit('Mine', { blobSha });
    expect(result).toMatchObject({ code: 'conflict:task-changed' });
    expect(store.writeCalls).toBe(writes);
    expect(store.text(SEEDS)).toBe(`${FM}Edited on the desktop\n`);
  });

  it('replay: the same operation again is already-applied with the same effect, one commit', async () => {
    const first = await edit('Once');
    const again = await commands().execute(Command.parse(first.raw), first.raw);
    expect(again).toMatchObject({ status: 'already-applied', commitSha: (first.result as Receipt).commitSha, effect: { kind: 'note-edited', path: SEEDS } });
    expect(store.commitsWithOp(first.raw.operationId)).toHaveLength(1);
  });

  it('lost response then retry: dedupe finds the applied commit', async () => {
    const r = NoteReadResponse.parse(await notes().readNote(SEEDS));
    store.writeFaults.push('apply-then-unknown');
    const raw = {
      schemaVersion: 1, operationId: uuid(), type: 'EditNote', occurredAt: AT, baseRevision: store.headCommit,
      payload: { note: { path: SEEDS, blobSha: r.status === 'ok' ? r.blobSha : '' }, body: 'Retried' },
    };
    const result = await commands().execute(Command.parse(raw), raw);
    expect(result).toMatchObject({ status: 'already-applied', effect: { kind: 'note-edited' } });
    expect(store.commitsWithOp(raw.operationId)).toHaveLength(1);
    expect(store.text(SEEDS)).toBe(`${FM}Retried\n`);
  });

  it('refusals: identical, conflict markers, mixed EOL, gone, subfolder path', async () => {
    expect((await edit('Tomatoes and basil\n')).result).toMatchObject({ code: 'refused:invalid-edit' });
    await store.commitFiles({ [SEEDS]: `${FM}<<<<<<< ours\na\n=======\nb\n>>>>>>> theirs\n` });
    expect((await edit('fixed')).result).toMatchObject({ code: 'refused:vault-conflict' });
    await store.commitFiles({ [SEEDS]: `${FM}a\r\nb\n` });
    expect((await edit('fixed')).result).toMatchObject({ code: 'refused:mixed-eol' });
    const r = NoteReadResponse.parse(await notes().readNote(SEEDS));
    const blobSha = r.status === 'ok' ? r.blobSha : '';
    await store.commitFiles({ [SEEDS]: null });
    expect((await edit('x', { blobSha })).result).toMatchObject({ code: 'conflict:task-changed' });
    // The contract already rejects a nested path; the plan refuses it too (defence in depth).
    const { editNotePlan } = await import('./commands.ts');
    const plan = editNotePlan({ ...Command.parse(first()), payload: { note: { path: 'Inbox/Archive/Old - 2026-01-01.md', blobSha }, body: 'x' } } as never);
    expect(await plan.compute(store, store.headCommit)).toMatchObject({ ok: false, code: 'refused:path' });
    expect(store.commitMessages().filter((m) => m === 'Vault Companion: edit note')).toHaveLength(0);
    function first() {
      return { schemaVersion: 1, operationId: uuid(), type: 'EditNote', occurredAt: AT, baseRevision: store.headCommit, payload: { note: { path: SEEDS, blobSha }, body: 'x' } };
    }
  });

  it('commit carries the operation trailer and no note text', async () => {
    const { result } = await edit('SECRET-note-text');
    const sha = (result as Receipt).commitSha;
    const info = await store.readCommit(sha);
    expect(info?.trailers[TRAILER_OP]).toBe((result as Receipt).operationId);
    expect(JSON.stringify(info?.trailers) + store.commitMessages().join()).not.toContain('SECRET');
  });
});
