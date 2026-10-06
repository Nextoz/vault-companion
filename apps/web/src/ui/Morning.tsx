// Reading view reached from Research Radar. Collapsed: a one-line brief.
// Expanded: the day's Reading Brief and the research explanations, each rendered read-only by the scout renderer.
import type { LinkedNoteResponse, MorningResponse } from '@vault-companion/contracts';
import { useEffect, useState } from 'react';
import { getMorning, type Fetched } from '../api.ts';

type Note = Extract<LinkedNoteResponse, { status: 'ok' }>;
type Render = (markdown: string) => string;

const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n/;

/** An explanation's title (its `# ` heading) and state (frontmatter `status:`; pending until explained). */
export function explanationInfo(markdown: string): { title: string; status: 'complete' | 'pending' | 'unavailable' | 'unknown' } {
  const fm = FRONTMATTER.exec(markdown)?.[0] ?? '';
  const status = /^status:\s*(\S+)\s*$/m.exec(fm)?.[1];
  const title = /^# (.+)$/m.exec(markdown.slice(fm.length))?.[1]?.trim() ?? 'Untitled paper';
  return { title, status: status === 'complete' || status === 'pending' || status === 'unavailable' ? status : 'unknown' };
}

/** The one-line brief shown while the panel is closed. */
export function morningSummary(data: MorningResponse): string {
  const notes = data.explained.filter((n): n is Note => n.status === 'ok').map((n) => explanationInfo(n.markdown).status);
  const parts = [data.brief?.status === 'ok' ? 'Reading brief' : 'No reading brief yet'];
  const done = notes.filter((s) => s === 'complete').length;
  const pending = notes.filter((s) => s === 'pending').length;
  if (done > 0) parts.push(`${done} explained`);
  if (pending > 0) parts.push(`${pending} pending`);
  return parts.join(' · ');
}

/** `startOpen` renders the panel expanded (Research Radar’s Reading link). */
export function Morning({ refreshKey, startOpen = false }: { refreshKey: number | null; startOpen?: boolean }) {
  const [result, setResult] = useState<Fetched<MorningResponse> | null>(null);
  const [open, setOpen] = useState(startOpen);
  const [render, setRender] = useState<Render | 'failed' | null>(null);
  useEffect(() => {
    let live = true;
    void getMorning().then((value) => { if (live) setResult(value); });
    return () => { live = false; };
  }, [refreshKey]);
  useEffect(() => {
    if (!open || render) return;
    let live = true;
    void import('../note/scout-render.ts').then(
      ({ createScoutRenderer }) => { if (live) setRender(() => createScoutRenderer(window)); },
      () => { if (live) setRender('failed'); },
    );
    return () => { live = false; };
  }, [open, render]);
  if (result?.kind !== 'ok') return null;
  const data = result.data;
  // Nothing to read this morning (no brief yet, no explanations): no panel.
  if (!data.brief && data.explained.length === 0) return null;
  const body = (note: LinkedNoteResponse) => {
    if (note.status !== 'ok') return <p className="muted small">{note.message}</p>;
    if (render === 'failed') return <p className="muted small">This note could not be displayed.</p>;
    if (!render) return <p className="muted small">Loading…</p>;
    return <article className="note-body scout-findings" dangerouslySetInnerHTML={{ __html: render(note.markdown.replace(FRONTMATTER, '')) }} />;
  };
  return <section className="group morning" aria-label="This morning">
    <h2>
      <button type="button" className="link group-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>This morning</button>
    </h2>
    <p className="muted small" data-testid="morning-summary">{morningSummary(data)}</p>
    {open && <>
      {data.brief && <details open><summary>Reading brief</summary>{body(data.brief)}</details>}
      {data.explained.map((note, i) => {
        const info = note.status === 'ok' ? explanationInfo(note.markdown) : { title: 'Unreadable note', status: 'unknown' as const };
        return <details key={note.status === 'ok' ? note.path : i} data-testid="morning-explained">
          <summary>{info.title}{info.status !== 'complete' && <span className="muted small"> · {info.status}</span>}</summary>
          {body(note)}
        </details>;
      })}
    </>}
  </section>;
}
