// Inbox notes on the device (ADR-0022): API calls, EditNote envelope, export text, and the edit gate.
import { decodeNoteHeader, type Receipt } from '@vault-companion/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getNote, getNotes } from './api.ts';
import { editNote, exportText } from './commands.ts';
import { canStartEdit, latestNoteEdit, noteTaskKey } from './notes.ts';
import type { QueueItem } from './queue/queue.ts';

const PATH = 'Inbox/Blåbær - 2026-09-27.md';
const BLOB = 'b'.repeat(40);
const REV = 'c'.repeat(40);
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

describe('api', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('getNote sends the path only in the X-VC-Note header, and ignores new server fields (.strip)', async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => json({
      status: 'ok', revision: REV, path: PATH, blobSha: BLOB, markdown: 'x\n', frontmatter: '', body: 'x\n', future: 1,
    }));
    vi.stubGlobal('fetch', fetch);
    const r = await getNote(PATH);
    expect(r).toEqual({ kind: 'ok', data: { status: 'ok', revision: REV, path: PATH, blobSha: BLOB, markdown: 'x\n', frontmatter: '', body: 'x\n' } });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('/api/notes/read');
    const header = (init!.headers as Record<string, string>)['X-VC-Note']!;
    expect(header).toMatch(/^[\x21-\x7e]+$/);
    expect(decodeNoteHeader(header)).toBe(PATH);
  });

  it('getNotes parses the list and tolerates new fields', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ revision: REV, notes: [{ path: PATH, title: 'Blåbær', date: '2026-09-27', blobSha: BLOB }], extra: true })));
    expect(await getNotes()).toMatchObject({ kind: 'ok', data: { notes: [{ path: PATH, title: 'Blåbær' }] } });
  });
});

describe('EditNote envelope', () => {
  it('mints a checked envelope and exports the typed body', () => {
    const cmd = editNote({ baseRevision: REV }, { path: PATH, blobSha: BLOB }, 'New text\nline two');
    expect(cmd).toMatchObject({ type: 'EditNote', payload: { note: { path: PATH, blobSha: BLOB }, body: 'New text\nline two' } });
    expect(exportText(cmd)).toBe('New text\nline two');
  });
  it('refuses nested paths and bodies over 50,000 characters on the device', () => {
    expect(() => editNote({ baseRevision: REV }, { path: 'Inbox/Sub/a.md', blobSha: BLOB }, 'x')).toThrow();
    expect(() => editNote({ baseRevision: REV }, { path: PATH, blobSha: BLOB }, 'x'.repeat(50_001))).toThrow();
  });
});

describe('edit gate', () => {
  const item = (seq: number, state: QueueItem['state'], over: Partial<QueueItem> = {}): QueueItem => ({
    operationId: `op${seq}`, seq, type: 'EditNote', label: 'Blåbær', taskKey: noteTaskKey(PATH), accountKey: 'a', state,
    error: null, everSent: false, accountMismatch: false, acknowledged: false,
    receipt: state === 'saved' ? ({ blobSha: `${seq}`.repeat(40).slice(0, 40) } as Receipt) : null,
    envelope: editNote({ baseRevision: REV }, { path: PATH, blobSha: BLOB }, `v${seq}`),
    ...over,
  });

  it('finds the newest edit of this note for this account only', () => {
    const other = item(9, 'pending', { envelope: editNote({ baseRevision: REV }, { path: 'Inbox/Other.md', blobSha: BLOB }, 'x') });
    const foreign = item(8, 'pending', { accountKey: 'b' });
    expect(latestNoteEdit([item(1, 'saved'), item(2, 'pending'), other, foreign], PATH, 'a')?.seq).toBe(2);
    expect(latestNoteEdit([other], PATH, 'a')).toBeNull();
  });

  it('a second edit waits for the first to be saved AND for a read that contains it', () => {
    expect(canStartEdit(null, BLOB)).toBe(true);
    expect(canStartEdit(item(1, 'pending'), BLOB)).toBe(false);
    expect(canStartEdit(item(1, 'saving'), BLOB)).toBe(false);
    expect(canStartEdit(item(1, 'attention'), BLOB)).toBe(false);
    const saved = item(1, 'saved');
    expect(canStartEdit(saved, BLOB)).toBe(false);
    expect(canStartEdit(saved, saved.receipt!.blobSha)).toBe(true);
  });
});
