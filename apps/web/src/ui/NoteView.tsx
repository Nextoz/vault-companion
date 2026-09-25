import type { LinkedNoteRefusalCode, LinkedNoteResponse, TaskView } from '@vault-companion/contracts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { getLinkedNote, type Fetched } from '../api.ts';
import type { NoteRenderer } from '../note/render.ts';

export interface OpenLink {
  task: TaskView;
  linkIndex: number;
  /** What the link shows in the task (alias or target): the heading until the note arrives. */
  label: string;
}

const REFUSED: Record<LinkedNoteRefusalCode, string> = {
  'not-found': 'No note with this name was found.',
  ambiguous: 'Several notes have this name. Open it in Obsidian.',
  'outside-allowlist': 'This note is outside the folders the app may open.',
  'too-large': 'This note is too large to show here.',
  'task-changed': 'The task changed since the list was loaded. Go back and try again.',
  encoding: 'This note cannot be displayed.',
};

/** Loaded on first use: Markdown and the sanitiser stay out of the start-up bundle. */
let renderer: Promise<NoteRenderer> | null = null;
const loadRenderer = () => (renderer ??= import('../note/render.ts').then((m) => m.createNoteRenderer(window)));

const titleOf = (path: string) => path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/, '');

/** Read-only linked note. Nothing it shows is stored: no IndexedDB, and `/api/*` is never cached by the SW. */
export function NoteView({ link, onClose }: { link: OpenLink; onClose: () => void }) {
  const [res, setRes] = useState<Fetched<LinkedNoteResponse> | null>(null);
  const [render, setRender] = useState<NoteRenderer | 'failed' | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    let live = true;
    setRes(null);
    void getLinkedNote({ taskLocator: link.task.locator, linkIndex: link.linkIndex }).then((r) => {
      if (live) setRes(r);
    });
    loadRenderer().then(
      (r) => live && setRender(() => r),
      () => live && setRender('failed'),
    );
    return () => {
      live = false;
    };
  }, [link]);

  useEffect(() => {
    heading.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const note = res?.kind === 'ok' && res.data.status === 'ok' ? res.data : null;
  // Raw HTML disabled + allowlist sanitiser (render.ts); the only HTML this app ever inserts.
  const html = useMemo(() => (note && typeof render === 'function' ? render(note.markdown) : ''), [note, render]);
  const title = note ? titleOf(note.path) : link.label;

  let message: string | null = null;
  if (note && render === 'failed') message = 'Could not display this note. Reload the app and try again.';
  else if (res === null || (note && render === null)) message = 'Loading…';
  else if (res.kind === 'offline') message = 'Offline. Notes are only shown while connected.';
  else if (res.kind === 'signed-out') message = 'Signed out — reload to sign in.';
  else if (res.kind === 'error') message = 'Could not load this note.';
  else if (res.data.status === 'refused') message = REFUSED[res.data.code];

  return (
    <div className="note-view" role="dialog" aria-modal="true" aria-labelledby="note-title">
      <header className="note-head">
        <button type="button" onClick={onClose} aria-label="Back to tasks">
          ‹ Back
        </button>
        <h2 id="note-title" ref={heading} tabIndex={-1}>
          {title}
        </h2>
        <span className="note-badge">Read-only</span>
      </header>
      {message !== null ? (
        <p className="muted note-message" role="status">
          {message}
        </p>
      ) : (
        <article className="note-body" data-testid="note-body" dangerouslySetInnerHTML={{ __html: html }} />
      )}
    </div>
  );
}
