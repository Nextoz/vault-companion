import {
  effectiveRadarDecisions,
  ResearchRadarDecideCommand,
  type RadarDecision,
  type RadarDecisionLine,
  type RadarPaper,
  type RadarResponse,
  type ResearchRadarDecideCommand as ResearchRadarDecideCommandType,
} from '@vault-companion/contracts';
import { useEffect, useRef, useState } from 'react';
import { getRadar, getRadarNote, postRadarDecision, type Fetched } from '../api.ts';
import { createNoteRenderer } from '../note/render.ts';
import { classify } from '../queue/classify.ts';
import { isoWithOffset } from '../time.ts';
import './ResearchRadar.css';

export type RadarSaveStatus = 'pending' | 'saving' | 'saved' | 'failure';

/** A user intent that has not yet been durably recorded and acknowledged by a server refresh. */
export interface RadarIntent {
  readonly command: ResearchRadarDecideCommandType;
  readonly attempts: number;
  readonly status: 'pending' | 'failure';
  readonly error: string | null;
  /** For an Undo intent: the decision ID it must wait for before it may be sent. */
  readonly dependsOn?: string | null;
  /** True after the server returned a receipt but before the next authoritative refresh removed the intent. */
  readonly acked?: boolean;
}

export interface RadarCardView extends RadarPaper {
  decision: RadarDecision | null;
  decisionId: string | null;
  saveStatus: RadarSaveStatus | null;
}

export interface RadarDecisionView extends RadarDecisionLine {
  saveStatus: RadarSaveStatus | null;
  intent: RadarIntent | null;
}

export function radarDecisionCommand(
  paper: RadarPaper,
  decision: Exclude<RadarDecision, 'undo'>,
  baseRevision: string,
  now: Date = new Date(),
): ResearchRadarDecideCommandType {
  return ResearchRadarDecideCommand.parse({
    schemaVersion: 1,
    operationId: crypto.randomUUID(),
    type: 'ResearchRadarDecide',
    occurredAt: isoWithOffset(now),
    baseRevision,
    payload: {
      paperId: paper.paperId,
      decision,
      undoes: null,
      card: { title: paper.title, source: paper.sourceUrl, topic: paper.topic },
    },
  });
}

export function radarUndoDecisionCommand(
  line: RadarDecisionLine,
  baseRevision: string,
  now: Date = new Date(),
): ResearchRadarDecideCommandType {
  return ResearchRadarDecideCommand.parse({
    schemaVersion: 1,
    operationId: crypto.randomUUID(),
    type: 'ResearchRadarDecide',
    occurredAt: isoWithOffset(now),
    baseRevision,
    payload: {
      paperId: line.paperId,
      decision: 'undo',
      undoes: line.decisionId,
      card: { title: line.card.title, source: line.card.source, topic: line.card.topic },
    },
  });
}

function lineFromCommand(command: ResearchRadarDecideCommandType): RadarDecisionLine {
  return {
    schemaVersion: 1,
    decisionId: command.operationId,
    paperId: command.payload.paperId,
    decision: command.payload.decision,
    undoes: command.payload.undoes,
    at: command.occurredAt,
    card: command.payload.card,
  };
}

function intentStatus(
  decisionId: string,
  decision: RadarDecision,
  read: RadarResponse,
  intents: readonly RadarIntent[],
  savingIds: ReadonlySet<string>,
): RadarSaveStatus | null {
  if (decision !== 'keep') return null;
  if (savingIds.has(decisionId)) return 'saving';
  const intent = intents.find((item) => item.command.operationId === decisionId);
  if (intent) return intent.status;
  const applied = read.applied[decisionId];
  if (applied?.status === 'applied') return 'saved';
  if (applied?.status === 'failed') return 'failure';
  return 'pending';
}

export interface RadarView {
  cards: RadarCardView[];
  topics: readonly { topic: string; count: number }[];
  decisions: readonly RadarDecisionView[];
}

export function deriveRadar(
  read: RadarResponse,
  intents: readonly RadarIntent[],
  savingIds: ReadonlySet<string>,
): RadarView {
  const serverIds = new Set(read.decisions.map((line) => line.decisionId));
  const localIntents = intents.filter((intent) => !serverIds.has(intent.command.operationId));
  const lines = [...read.decisions, ...localIntents.map((intent) => lineFromCommand(intent.command))];
  const state = effectiveRadarDecisions(lines);
  const intentByDecision = new Map(intents.map((intent) => [intent.command.operationId, intent]));

  const visible = read.papers
    .filter((paper) => !state.removed.has(paper.paperId) && !state.kept.has(paper.paperId))
    .slice(0, 3);
  const cards: RadarCardView[] = visible.map((paper) => {
    const latest = state.latestByPaper.get(paper.paperId) ?? null;
    const keepId = state.keepDecisionByPaper.get(paper.paperId) ?? latest?.decisionId ?? null;
    return {
      ...paper,
      decision: latest?.decision ?? null,
      decisionId: latest?.decisionId ?? null,
      saveStatus: intentStatus(keepId ?? latest?.decisionId ?? '', latest?.decision ?? 'keep', read, intents, savingIds),
    };
  });

  const decisionViews: RadarDecisionView[] = [];
  for (const [paperId, latest] of state.latestByPaper) {
    if (latest.decision === 'undo' || (!state.removed.has(paperId) && !state.kept.has(paperId))) continue;
    const keepId = state.keepDecisionByPaper.get(paperId) ?? latest.decisionId;
    decisionViews.push({
      ...latest,
      saveStatus: intentStatus(keepId, latest.decision, read, intents, savingIds),
      intent: intentByDecision.get(latest.decisionId) ?? null,
    });
  }

  const seen = new Set(decisionViews.map((line) => line.decisionId));
  for (const intent of localIntents) {
    const line = lineFromCommand(intent.command);
    if (seen.has(line.decisionId)) continue;
    seen.add(line.decisionId);
    decisionViews.push({
      ...line,
      saveStatus: intentStatus(line.decisionId, line.decision, read, intents, savingIds),
      intent,
    });
  }
  decisionViews.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return { cards, topics: read.topics, decisions: decisionViews };
}

const STORAGE_PREFIX = 'vault-companion:radar-pending:v1:';
const storageKey = (accountKey: string | null) => `${STORAGE_PREFIX}${accountKey ?? 'signed-out'}`;

function loadRadarIntents(accountKey: string | null): RadarIntent[] {
  if (!accountKey) return [];
  try {
    const raw = localStorage.getItem(storageKey(accountKey));
    if (!raw) return [];
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    const intents: RadarIntent[] = [];
    for (const entry of value) {
      if (entry === null || typeof entry !== 'object') continue;
      const candidate = entry as { command?: unknown; attempts?: unknown; status?: unknown; error?: unknown; dependsOn?: unknown; acked?: unknown };
      const command = ResearchRadarDecideCommand.safeParse(candidate.command);
      if (!command.success) continue;
      intents.push({
        command: command.data,
        attempts: Number.isInteger(candidate.attempts) ? (candidate.attempts as number) : 0,
        status: candidate.status === 'failure' ? 'failure' : 'pending',
        error: typeof candidate.error === 'string' ? candidate.error : null,
        dependsOn: typeof candidate.dependsOn === 'string' ? candidate.dependsOn : null,
        acked: candidate.acked === true,
      });
    }
    return intents;
  } catch {
    return [];
  }
}

function saveRadarIntents(accountKey: string | null, intents: readonly RadarIntent[]): boolean {
  if (!accountKey) return false;
  try {
    localStorage.setItem(storageKey(accountKey), JSON.stringify(intents));
    return true;
  } catch {
    return false;
  }
}

interface RadarNoteView {
  readonly paperId: string;
  readonly title: string;
  readonly html: string | null;
  readonly message: string | null;
}

export function ResearchRadar({ accountKey, refreshKey, blocked }: {
  accountKey: string | null;
  refreshKey: number | null;
  blocked: boolean;
}) {
  const [read, setRead] = useState<RadarResponse | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [intents, setIntents] = useState<RadarIntent[]>(() => loadRadarIntents(accountKey));
  const [savingIds, setSavingIds] = useState<ReadonlySet<string>>(new Set());
  const [storageOk, setStorageOk] = useState(true);
  const [noteView, setNoteView] = useState<RadarNoteView | null>(null);
  const chain = useRef<Promise<void>>(Promise.resolve());
  const mountedRef = useRef(true);
  const noteRequestRef = useRef(0);
  const accountRef = useRef(accountKey);
  const blockedRef = useRef(blocked);
  const readRef = useRef<RadarResponse | null>(read);
  const intentsRef = useRef<RadarIntent[]>(intents);
  const savingRef = useRef<ReadonlySet<string>>(savingIds);
  const storageOkRef = useRef(storageOk);
  const ackedRef = useRef<ReadonlySet<string>>(new Set());

  function applyRead(result: Fetched<RadarResponse>) {
    if (result.kind === 'ok') {
      setRead(result.data);
      setError(null);
    } else if (result.kind === 'signed-out') {
      setRead(null);
      setOpen(false);
    } else {
      setError('Research Radar could not be refreshed.');
    }
  }

  async function refresh(startAccount: string): Promise<RadarResponse | null> {
    const result = await getRadar();
    if (accountRef.current !== startAccount) return null;
    applyRead(result);
    return result.kind === 'ok' ? result.data : null;
  }

  function sendIntent(intent: RadarIntent) {
    const startAccount = accountRef.current;
    if (!startAccount || blockedRef.current) return;
    const id = intent.command.operationId;
    if (savingRef.current.has(id)) return;
    setSavingIds((current) => new Set(current).add(id));
    chain.current = chain.current.then(async () => {
      if (accountRef.current !== startAccount || blockedRef.current) return;
      try {
        const dependency = intent.dependsOn ?? null;
        const serverIds = new Set(readRef.current?.decisions.map((line) => line.decisionId) ?? []);
        if (dependency && !ackedRef.current.has(dependency) && !serverIds.has(dependency)) {
          if (accountRef.current !== startAccount) return;
          setIntents((current) => current.map((item) => item.command.operationId === id
            ? { ...item, status: 'pending', error: 'Waiting for the original decision to save.' }
            : item));
          return;
        }
        const response = await postRadarDecision(JSON.stringify(intent.command), startAccount);
        const outcome = await classify(response, id);
        if (accountRef.current !== startAccount || blockedRef.current) return;
        if (outcome.kind === 'receipt') {
          ackedRef.current = new Set(ackedRef.current).add(id);
          setIntents((current) => current.map((item) => item.command.operationId === id
            ? { ...item, acked: true, status: 'pending', error: null }
            : item));
          setError(null);
          const fresh = await refresh(startAccount);
          if (fresh) {
            const freshIds = new Set(fresh.decisions.map((line) => line.decisionId));
            for (const pending of intentsRef.current) {
              if (pending.command.operationId === id) continue;
              if (pending.dependsOn && freshIds.has(pending.dependsOn) && !freshIds.has(pending.command.operationId)) {
                sendIntent(pending);
              }
            }
          }
        } else if (outcome.kind === 'signed-out') {
          setRead(null);
          setOpen(false);
          setError('Sign in to save Radar decisions.');
        } else {
          const status = outcome.kind === 'attention' ? 'failure' as const : 'pending' as const;
          setIntents((current) => current.map((item) => item.command.operationId === id
            ? { ...item, attempts: item.attempts + 1, status, error: outcome.error.message }
            : item));
          setError(outcome.kind === 'attention' ? outcome.error.message : 'Radar decision is waiting to retry.');
        }
      } catch {
        if (accountRef.current !== startAccount || blockedRef.current) return;
        const saved = storageOkRef.current;
        setIntents((current) => current.map((item) => item.command.operationId === id
          ? { ...item, attempts: item.attempts + 1, status: 'pending', error: saved ? 'Offline. The decision is saved on this device.' : 'Offline. The decision could not be saved on this device.' }
          : item));
        setError('Radar decision is waiting to retry.');
      } finally {
        setSavingIds((current) => {
          const next = new Set(current);
          next.delete(id);
          return next;
        });
      }
    });
  }

  function decide(paper: RadarPaper, decision: Exclude<RadarDecision, 'undo'>) {
    if (!read || blockedRef.current || !accountRef.current) return;
    const command = radarDecisionCommand(paper, decision, read.revision);
    const intent: RadarIntent = { command, attempts: 0, status: 'pending', error: null };
    setIntents((current) => [...current, intent]);
    sendIntent(intent);
  }

  function undoDecision(line: RadarDecisionView) {
    if (!read || blockedRef.current || !accountRef.current || savingRef.current.has(line.decisionId)) return;
    const command = radarUndoDecisionCommand(line, read.revision);
    const intent: RadarIntent = { command, attempts: 0, status: 'pending', error: null, dependsOn: line.decisionId };
    setIntents((current) => [...current, intent]);
    sendIntent(intent);
  }

  function retryIntent(intent: RadarIntent) {
    if (!accountRef.current || blockedRef.current || savingRef.current.has(intent.command.operationId)) return;
    setIntents((current) => current.map((item) => item.command.operationId === intent.command.operationId
      ? { ...item, error: null }
      : item));
    sendIntent(intent);
  }

  async function readPaper(paper: RadarPaper) {
    if (paper.read.kind === 'source') return;
    const startAccount = accountRef.current;
    if (!startAccount || blockedRef.current) return;
    const requestId = ++noteRequestRef.current;
    setNoteView({ paperId: paper.paperId, title: paper.title, html: null, message: 'Loading Radar note…' });
    const result = await getRadarNote(paper.paperId);
    if (!mountedRef.current || requestId !== noteRequestRef.current || accountRef.current !== startAccount || blockedRef.current) return;
    if (result.kind !== 'ok') {
      setNoteView({
        paperId: paper.paperId,
        title: paper.title,
        html: null,
        message: result.kind === 'signed-out' ? 'Sign in to read this Radar note.' : result.kind === 'offline' ? 'The Radar note is unavailable offline.' : result.message,
      });
      return;
    }
    if (result.data.status !== 'ok') {
      setNoteView({ paperId: paper.paperId, title: paper.title, html: null, message: result.data.message });
      return;
    }
    try {
      const html = createNoteRenderer(window)(result.data.markdown);
      setNoteView({ paperId: paper.paperId, title: paper.title, html, message: null });
    } catch {
      setNoteView({ paperId: paper.paperId, title: paper.title, html: null, message: 'The Radar note could not be displayed.' });
    }
  }

  useEffect(() => {
    accountRef.current = accountKey;
    ackedRef.current = new Set();
    noteRequestRef.current += 1;
    setIntents(loadRadarIntents(accountKey));
    setNoteView(null);
  }, [accountKey]);

  useEffect(() => {
    mountedRef.current = true;
    noteRequestRef.current += 1;
    return () => {
      mountedRef.current = false;
      noteRequestRef.current += 1;
    };
  }, []);

  useEffect(() => {
    blockedRef.current = blocked;
    if (blocked) setNoteView(null);
  }, [blocked]);

  useEffect(() => {
    intentsRef.current = intents;
    setStorageOk(saveRadarIntents(accountKey, intents));
  }, [accountKey, intents]);

  useEffect(() => {
    storageOkRef.current = storageOk;
  }, [storageOk]);

  useEffect(() => {
    savingRef.current = savingIds;
  }, [savingIds]);

  useEffect(() => {
    readRef.current = read;
    if (!read) return;
    const serverIds = new Set(read.decisions.map((line) => line.decisionId));
    setIntents((current) => {
      const next = current.filter((intent) => !intent.acked && !serverIds.has(intent.command.operationId));
      return next.length === current.length ? current : next;
    });
  }, [read]);

  useEffect(() => {
    const startAccount = accountKey;
    let live = true;
    void getRadar().then((result) => {
      if (!live || accountRef.current !== startAccount) return;
      applyRead(result);
    });
    return () => {
      live = false;
    };
  }, [refreshKey, accountKey]);

  const view = read ? deriveRadar(read, intents, savingIds) : null;

  return (
    <section className="group research-radar" aria-label="Research Radar">
      <h2>
        <button type="button" className="link group-toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          Research Radar
        </button>
      </h2>
      {view && (
        <p className="muted small" data-testid="radar-summary">
          {view.cards.length === 0 ? 'No papers yet' : `${view.cards.length} paper${view.cards.length === 1 ? '' : 's'} ranked this week`}
        </p>
      )}
      {error && <p role="status">{error}</p>}
      {open && read && view && (
        <>
          {read.warnings.length > 0 && <p className="muted small" role="status">{read.warnings.join(' ')}</p>}
          {view.topics.length > 0 && (
            <ul className="radar-topics" aria-label="Research topics">
              {view.topics.map((topic) => (
                <li key={topic.topic} className="chip">{topic.topic} · {topic.count}</li>
              ))}
            </ul>
          )}
          {noteView && (
            <div className="radar-note-view" data-testid="radar-note-view">
              <button type="button" onClick={() => setNoteView(null)}>Back to papers</button>
              <h3>{noteView.title}</h3>
              {noteView.html !== null
                ? <article className="note-body" dangerouslySetInnerHTML={{ __html: noteView.html }} />
                : <p role="status">{noteView.message}</p>}
            </div>
          )}
          {!noteView && view.cards.length === 0 && <p>No eligible papers in the last seven days.</p>}
          {!noteView && (
            <ul className="radar-cards">
              {view.cards.map((paper) => (
                <li key={paper.paperId} className="radar-card" data-testid="radar-card">
                  <div className="radar-card-head">
                    <span className="radar-rank">#{paper.rank}</span>
                    <h3>{paper.title}</h3>
                    {paper.badges.includes('important') && <span className="radar-badge badge-important">Important</span>}
                    {paper.badges.includes('explained') && <span className="radar-badge badge-explained">Explained</span>}
                  </div>
                  {paper.why && <p className="radar-why">{paper.why}</p>}
                  <div className="radar-card-foot">
                    <span className="chip">{paper.topic}</span>
                    {paper.read.kind === 'source'
                      ? <a
                          className="radar-read"
                          data-read-kind="source"
                          href={/^https?:\/\//i.test(paper.sourceUrl) ? paper.sourceUrl : undefined}
                          target="_blank"
                          rel="noreferrer"
                        >Read</a>
                      : <button type="button" className="radar-read" data-read-kind={paper.read.kind} onClick={() => void readPaper(paper)}>Read</button>}
                    <button type="button" disabled={blocked || !accountKey || savingIds.size > 0} onClick={() => decide(paper, 'remove')}>Remove</button>
                    <button type="button" disabled={blocked || !accountKey || savingIds.size > 0} onClick={() => decide(paper, 'keep')}>Keep</button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {view.decisions.length > 0 && (
            <ul className="radar-decisions" aria-label="Radar decisions">
              {view.decisions.map((line) => (
                <li key={line.decisionId} className="radar-decision" data-testid="radar-decision">
                  <span>{line.decision === 'remove' ? 'Removed' : line.decision === 'keep' ? 'Keep' : 'Undo'}</span>
                  <span className="radar-decision-title">{line.card.title}</span>
                  {line.decision === 'keep' && line.saveStatus === 'saving' && <span role="status">Saving to Library…</span>}
                  {line.decision === 'keep' && line.saveStatus === 'pending' && <span className="muted small">Saving to Library pending</span>}
                  {line.decision === 'keep' && line.saveStatus === 'saved' && <span role="status">Saved to Library</span>}
                  {line.decision === 'keep' && line.saveStatus === 'failure' && <span className="error">Library save failed</span>}
                  {line.intent?.error && <span className="error">{line.intent.error}</span>}
                  {line.intent && !savingIds.has(line.decisionId) && <button type="button" onClick={() => retryIntent(line.intent!)}>Retry</button>}
                  {line.decision !== 'undo' && <button type="button" disabled={blocked || !accountKey || savingIds.has(line.decisionId)} onClick={() => undoDecision(line)}>Undo</button>}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
