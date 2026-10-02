// Inbox notes (ADR-0022): list → note → edit. Nothing here is stored on the device except a queued edit; note text is
// fetched `no-store` and never cached by the SW. The last answers are kept in memory only (SP3, ADR-0038).
import type { NoteReadResponse, NotesResponse } from '@vault-companion/contracts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { getNote, getNotes, type Fetched } from '../api.ts';
import { editNote } from '../commands.ts';
import { canStartEdit, latestNoteEdit, noteTaskKey } from '../notes.ts';
import type { PendingQueue, QueueItem } from '../queue/queue.ts';
import type { NoteRenderer } from '../note/render.ts';
import { loadRenderer, REFUSED } from './NoteView.tsx';
import { CopyNote, useLastCopy } from './useLastCopy.tsx';

type Entry = NotesResponse['notes'][number];
type OkNote = Extract<NoteReadResponse, { status: 'ok' }>;

const unavailable = (r: Exclude<Fetched<unknown>, { kind: 'ok' }>, what: string) =>
  r.kind === 'error' ? r.message : r.kind === 'signed-out' ? `Sign in to view ${what}.` : `${what[0]!.toUpperCase()}${what.slice(1)} are only shown while connected.`;

export function Notes({ refreshKey, queue, items, accountKey, baseRevision }: {
  refreshKey: number | null;
  queue: PendingQueue;
  items: readonly QueueItem[];
  accountKey: string | null;
  baseRevision: string | null;
}) {
  const listView = useLastCopy(accountKey, 'notes', getNotes, refreshKey);
  const list = listView.res;
  const [open, setOpen] = useState<Entry | null>(null);

  if (open) {
    return <NoteScreen entry={open} refreshKey={refreshKey} queue={queue} items={items} accountKey={accountKey}
      baseRevision={baseRevision} onBack={() => setOpen(null)} />;
  }
  const data = list?.kind === 'ok' ? list.data : null;
  return <section aria-label="Notes" className="notes">
    <h1>Notes</h1>
    <CopyNote view={listView} />
    {(!list || list.kind !== 'ok') && <p role="status">{!list ? 'Loading notes…' : unavailable(list, 'notes')}</p>}
    {data?.notes.length === 0 && <p className="muted">No notes in the Inbox yet.</p>}
    {data && data.notes.length > 0 && <ul className="note-list">
      {data.notes.map((n) => <li key={n.path}>
        <button type="button" className="note-row" data-testid="note-row" onClick={() => setOpen(n)}>
          <span className="note-row-title">{n.title}</span>
          {n.date && <span className="muted small">{n.date}</span>}
        </button>
      </li>)}
    </ul>}
  </section>;
}

export function NoteScreen({ entry, refreshKey, queue, items, accountKey, baseRevision, onBack }: {
  entry: Entry;
  refreshKey: number | null;
  queue: PendingQueue;
  items: readonly QueueItem[];
  accountKey: string | null;
  baseRevision: string | null;
  onBack: () => void;
}) {
  const view = useLastCopy(accountKey, `note:${entry.path}`, () => getNote(entry.path), refreshKey);
  const res = view.res;
  const [render, setRender] = useState<NoteRenderer | 'failed' | null>(null);
  const [editing, setEditing] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    let live = true;
    loadRenderer().then((r) => live && setRender(() => r), () => live && setRender('failed'));
    return () => { live = false; };
  }, []);
  useEffect(() => heading.current?.focus(), []);

  const note: OkNote | null = res?.kind === 'ok' && res.data.status === 'ok' ? res.data : null;
  // Only the body is shown: the frontmatter is kept by the server and never edited here.
  const html = useMemo(() => (note && typeof render === 'function' ? render(note.body) : ''), [note, render]);
  const latest = latestNoteEdit(items, entry.path, accountKey);

  let message: string | null = null;
  if (note && render === 'failed') message = 'Could not display this note. Reload the app and try again.';
  else if (res === null || (note && render === null)) message = 'Loading…';
  else if (res.kind !== 'ok') message = unavailable(res, 'notes');
  else if (res.data.status === 'refused') message = res.data.code === 'not-found' ? 'This note is no longer in the Inbox.' : REFUSED[res.data.code];

  // A copy is never edited: Edit waits for this read's answer, so the edit's blob SHA is the vault's current one.
  const editable = note !== null && view.copyAt === null && accountKey !== null && baseRevision !== null && canStartEdit(latest, note.blobSha);
  return <section aria-label="Note" className="notes">
    <header className="note-head">
      <button type="button" onClick={onBack} aria-label="Back to notes">‹ Back</button>
      <h1 ref={heading} tabIndex={-1}>{entry.title}</h1>
      {note && <button type="button" className="primary" disabled={!editable} onClick={() => setEditing(true)}>Edit</button>}
    </header>
    <CopyNote view={view} />
    {latest && <p className="muted small" role="status" data-testid="note-edit-state">
      {latest.state === 'saved' ? 'Saved to the vault; reaches Obsidian at your next desktop sync'
        : latest.state === 'attention' ? 'Your edit needs attention — see Actions below.' : 'Saving your edit…'}
    </p>}
    {message !== null
      ? <p className="muted note-message" role="status">{message}</p>
      : <article className="note-body" data-testid="note-body" dangerouslySetInnerHTML={{ __html: html }} />}
    {editing && note && accountKey && baseRevision &&
      <NoteEditSheet note={note} title={entry.title} queue={queue} accountKey={accountKey} baseRevision={baseRevision} onClose={() => setEditing(false)} />}
  </section>;
}

function NoteEditSheet({ note, title, queue, accountKey, baseRevision, onClose }: {
  note: OkNote; title: string; queue: PendingQueue; accountKey: string; baseRevision: string; onClose: () => void;
}) {
  const [text, setText] = useState(note.body);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const guard = useRef(false);
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const invoker = document.activeElement;
    dialog.current?.querySelector('textarea')?.focus();
    return () => { if (invoker instanceof HTMLElement && invoker.isConnected) invoker.focus(); };
  }, []);
  const tooLong = text.length > 50_000;
  const canSave = !saving && !tooLong && text !== note.body;
  const save = async () => {
    if (!canSave || guard.current) return;
    guard.current = true;
    setSaving(true);
    try {
      // Offline works: the edit waits in the queue; a refusal keeps the typed text in Actions (Export text).
      await queue.enqueue(editNote({ baseRevision }, { path: note.path, blobSha: note.blobSha }, text), {
        accountKey, label: title, taskKey: noteTaskKey(note.path),
      });
      onClose();
    } catch {
      setError('Could not keep this edit on the device. Your text is still here.');
    } finally { guard.current = false; setSaving(false); }
  };
  return <div className="sheet-backdrop" role="presentation">
    <div ref={dialog} className="sheet edit-sheet note-edit-sheet" role="dialog" aria-modal="true" aria-label="Edit note"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !saving) onClose();
        if (e.key !== 'Tab') return;
        const controls = dialog.current?.querySelectorAll<HTMLElement>('textarea, button:not(:disabled)');
        const first = controls?.[0]; const last = controls?.[controls.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }}>
      <h2>Edit note</h2>
      <textarea aria-label="Note text" value={text} rows={14} onChange={(e) => setText(e.target.value)} />
      {tooLong && <p role="alert" className="error">This note is longer than 50,000 characters; shorten it to save.</p>}
      {error && <p role="alert" className="error">{error}</p>}
      <p className="muted small">Saved to the vault; reaches Obsidian at your next desktop sync.</p>
      <div className="sheet-buttons">
        <button type="button" disabled={saving} onClick={onClose}>Cancel</button>
        <button type="button" className="primary" disabled={!canSave} onClick={() => void save()}>Save</button>
      </div>
    </div>
  </div>;
}
