import type { ActiveWorkResponse } from '@vault-companion/contracts';
import { useEffect, useMemo, useState } from 'react';
import { getActiveWork, type Fetched } from '../api.ts';
import type { NoteRenderer } from '../note/render.ts';
import { prefs } from '../prefs.ts';
import { activeWorkState } from '../reads.ts';

/** Loaded on first use: Markdown and the sanitiser stay out of the start-up bundle. */
let renderer: Promise<NoteRenderer> | null = null;
const loadRenderer = () => (renderer ??= import('../note/render.ts').then((m) => m.createNoteRenderer(window)));

/**
 * The owner's chosen outcomes (ADR-0012), read-only above Today. No task mapping, no actions; wikilinks are plain text.
 * Re-read whenever the task list's revision changes. Nothing here is stored beyond the collapse preference.
 */
export function ActiveWorkCard({ revision }: { revision: string | null }) {
  const [res, setRes] = useState<Fetched<ActiveWorkResponse> | null>(null);
  const [render, setRender] = useState<NoteRenderer | 'failed' | null>(null);
  const [collapsed, setCollapsed] = useState(() => prefs.activeWorkCollapsed());

  useEffect(() => {
    let live = true;
    void getActiveWork().then((r) => {
      if (live) setRes(r);
    });
    return () => {
      live = false;
    };
  }, [revision]);

  const state = activeWorkState(res);
  const markdown = state.kind === 'content' ? state.markdown : null;

  useEffect(() => {
    if (markdown === null || render !== null) return;
    let live = true;
    loadRenderer().then(
      (r) => live && setRender(() => r),
      () => live && setRender('failed'),
    );
    return () => {
      live = false;
    };
  }, [markdown, render]);

  // Raw HTML disabled + allowlist sanitiser (note/render.ts).
  const html = useMemo(() => (markdown !== null && typeof render === 'function' ? render(markdown) : null), [markdown, render]);

  if (state.kind === 'hidden') return null;
  const toggle = () => {
    setCollapsed(!collapsed);
    prefs.setActiveWorkCollapsed(!collapsed);
  };
  let body;
  if (state.kind === 'message') body = <p className="muted">{state.text}</p>;
  else if (render === 'failed') body = <p className="muted">Cannot be displayed.</p>;
  else if (html === null) body = <p className="muted">Loading…</p>;
  else body = <div className="note-body active-work-body" data-testid="active-work-body" dangerouslySetInnerHTML={{ __html: html }} />;

  return (
    <section className="group active-work" aria-label="Active work">
      <h2>
        <button type="button" className="active-work-toggle" aria-expanded={!collapsed} aria-controls="active-work-content" onClick={toggle}>
          Active work
        </button>
      </h2>
      {!collapsed && <div id="active-work-content">{body}</div>}
    </section>
  );
}
