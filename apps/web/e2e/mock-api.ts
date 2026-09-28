import { TrainingResponse, type TrainingRow } from '@vault-companion/contracts';
// In-page API mock for Playwright. Every response is parsed through the contract schema before it is served,
// so a mock that drifts from packages/contracts fails loudly instead of testing a fiction.
import {
  ActiveWorkResponse,
  ApiError,
  Command,
  decodeLinkedNoteHeader,
  decodeNoteHeader,
  HistoryResponse,
  type HistoryItem,
  LINKED_NOTE_HEADER,
  LinkedNoteResponse,
  type LinkedNoteRequest,
  NOTE_HEADER,
  NoteReadResponse,
  NotesResponse,
  Receipt,
  SessionResponse,
  ScoutsResponse,
  TasksResponse,
  TriageResponse,
  type TaskView,
} from '@vault-companion/contracts';
import type { BrowserContext, Page, Route } from '@playwright/test';
import { copenhagenDay } from '../src/triage.ts';

export const ACCOUNT = 'a'.repeat(64);
const TODAY = '2026-09-24';

let counter = 0;
const sha = () => (++counter).toString(16).padStart(40, '0');

export function taskView(lineIndex: number, description: string, extra: Partial<TaskView> = {}): TaskView {
  return {
    locator: {
      path: 'Tasks/To-Do List.md',
      blobSha: '2'.repeat(40),
      lineIndex,
      lineText: `- [ ] ${description} 📅 ${TODAY}`,
      occurrencesAtRead: 1,
    },
    description,
    status: 'open',
    section: 'open',
    priority: null,
    due: TODAY,
    scheduled: null,
    start: null,
    created: null,
    done: null,
    recurring: false,
    readOnlyReason: null,
    links: [],
    ...extra,
  };
}

/** `hold`: the request stays in flight until `release()`, then is answered as `ok`. */
export type CommandMode = 'ok' | 'offline' | 'unavailable' | 'hold' | { refuse: ApiError };

/** How a read (`/api/session`, `/api/tasks`) is answered; `hang`: never, until the page gives up. */
export type ReadMode = 'ok' | 'error' | 'offline' | 'hang';

export class MockApi {
  trainingRows: TrainingRow[] = [];
  trainingUnknownLines: string[] = [];
  #trainingBefore = new Map<string, TrainingRow[]>();
  session: 'ok' | 'signed-out' = 'ok';
  /** The account the session reports (switch it to simulate signing in as someone else). */
  account = ACCOUNT;
  /** `down`: every request fails as a network error and is not recorded (it never reached the server). */
  network: 'up' | 'down' = 'up';
  sessionMode: ReadMode = 'ok';
  tasksMode: ReadMode = 'ok';
  taskReads = 0;
  vault: TasksResponse['vault'] = { committedAt: '2026-09-26T12:07:00Z', fromApp: false };
  /** The read's writeBlock, e.g. a committed Git conflict in the task list. */
  writeBlock: ApiError | null = null;
  /** Largest `known=` list any task read asked about (review O1). */
  maxKnownAsked = 0;
  #rewritten = false;
  /** Blob of the task file in every read; change it to model a desktop edit. */
  blobSha = '2'.repeat(40);
  commandMode: CommandMode = 'ok';
  open: TaskView[] = [];
  doneToday: TaskView[] = [];
  /** Every POST body exactly as received, including failed attempts. */
  readonly bodies: string[] = [];
  readonly applied: Command[] = [];
  /** Linked-note answers by target; the mock resolves `links[linkIndex]` of the requested task like the server. */
  notes = new Map<string, { path: string; markdown: string }>();
  /** Every decoded linked-note request, and the raw URL it came on (must never carry task text). */
  /** Active Work Now: Markdown, `null` for an absent file, or `'error'` for a 503. */
  activeWork: string | null | 'error' = null;
  activeWorkItems: Extract<ActiveWorkResponse, { status: 'ok' }>['items'] = [];
  unknownNowLines: string[] = [];
  #awBefore = new Map<string, Extract<ActiveWorkResponse, { status: 'ok' }>['items']>();
  readonly noteRequests: { req: LinkedNoteRequest; url: string }[] = [];
  readonly #receipts = new Map<string, Receipt>();
  #held: (() => void)[] = [];
  #revision = sha();

  triage: TriageResponse = { revision: 'a'.repeat(40), now: '2026-09-27T12:00:00Z', feedState: 'absent', generatedAt: null,
    cards: [], droppedCards: 0, decisions: [], applied: {}, appliedUpdatedAt: null };

  scouts: ScoutsResponse = ScoutsResponse.parse({
    revision: 'a'.repeat(40), now: '2026-09-27T08:50:02+02:00', scouts: [
      { state: 'ok', file: 'city-events.json', status: {
        schemaVersion: 1, scoutId: 'city-events', displayName: 'City events', schedule: 'daily 06:50', expectedEveryHours: 24,
        lastAttemptAt: '2026-09-27T06:50:02+02:00', lastSuccessAt: null, runStatus: 'failed', sources: null, aiHealth: null,
        findings: null, added: null, errors: 1, lastError: 'runner could not start', latestOutput: null,
        history: [{ at: '2026-09-27T06:50:02+02:00', status: 'failed', findings: null }],
      } },
      { state: 'ok', file: 'learning.json', status: {
        schemaVersion: 1, scoutId: 'learning', displayName: 'Learning opportunities', schedule: 'daily 07:00', expectedEveryHours: 24,
        lastAttemptAt: '2026-09-27T07:00:00+02:00', lastSuccessAt: '2026-09-27T07:00:00+02:00', runStatus: 'success',
        sources: { configured: 3, successful: 3 }, aiHealth: 'healthy', findings: 4, added: 2, errors: 0,
        lastError: 'Previous run: one source timed out', latestOutput: 'Discoveries/Learning.md',
        history: [
          { at: '2026-09-26T07:00:00+02:00', status: 'degraded', findings: 2 },
          { at: '2026-09-27T07:00:00+02:00', status: 'success', findings: 4 },
        ],
      } },
      { state: 'unreadable', file: 'unreadable.json' },
    ],
  });
  readonly scoutOutputRequests: string[] = [];
  /** A scout id mapped to a promise holds that output read open until it settles (slow-scout tests). */
  readonly scoutOutputGates = new Map<string, Promise<void>>();
  scoutOutputs = new Map<string, string>([['learning', [
    '# Learning findings',
    '',
    'Four synthetic opportunities.',
    '',
    '| Opportunity | Provider | When |',
    '| --- | --- | --- |',
    '| [Platform workshop](https://example.com/workshop) | Example Guild | Tuesday |',
    '| Cloud meetup | Sample Community | Wednesday |',
    '| Mentoring circle | Demo Network | Friday |',
    '| Fourth listing | Example Org | Saturday |',
    '',
    '<script>alert(1)</script>',
  ].join('\n')]]);
  /** Completion history (ADR-0021): done-today tasks plus these earlier items, served newest first. */
  olderHistory: HistoryItem[] = [
    { source: 'active-work', description: 'Garden plan: beds ready [[Garden Plan]]', doneDate: '2026-09-23', links: ['Garden Plan'],
      locator: { path: 'Tasks/Active Work Now.md', blobSha: '3'.repeat(40), lineIndex: 12, lineText: '- [x] **Garden plan:** beds ready [[Garden Plan]] ✅ 2026-09-23', occurrencesAtRead: 1 } },
  ];
  /** Inbox notes (ADR-0022), by path: frontmatter is kept on edit, only the body changes. */
  inboxNotes = new Map<string, { title: string; date: string | null; blobSha: string; frontmatter: string; body: string }>([
    ['Inbox/Seed order - 2026-09-23.md', { title: 'Seed order', date: '2026-09-23', blobSha: 'd'.repeat(40),
      frontmatter: '---\ntype: inbox-note\n---\n', body: 'Tomatoes and **basil**.\n' }],
  ]);
  /** Every EditNote the mock applied (path, blob it was based on, body). */
  readonly noteEdits: { path: string; blobSha: string; body: string }[] = [];

  /** Route a page, or a whole context: only a context route also sees requests made by a service worker. */
  async install(target: Page | BrowserContext): Promise<void> {
    const on = (glob: string, handle: (route: Route) => Promise<void>) =>
      target.route(glob, (route) => (this.network === 'down' ? route.abort('internetdisconnected') : handle(route)));
    await on('**/api/scouts', (route) => this.session === 'signed-out'
      ? route.fulfill({ status: 401, body: '' })
      : this.#json(route, 200, ScoutsResponse.parse(this.scouts)));
    await on('**/api/scouts/output', async (route) => {
      if (this.session === 'signed-out') return route.fulfill({ status: 401, body: '' });
      const id = route.request().headers()['x-vc-scout'] ?? '';
      this.scoutOutputRequests.push(id);
      await this.scoutOutputGates.get(id);
      const markdown = this.scoutOutputs.get(id);
      return this.#json(route, 200, LinkedNoteResponse.parse(markdown !== undefined
        ? { status: 'ok', revision: this.#revision, blobSha: 'b'.repeat(40), path: `Discoveries/${id}.md`, markdown }
        : { status: 'refused', revision: this.#revision, code: 'not-found', message: 'No findings note yet.' }));
    });
    await on('**/api/session', (route) => this.#session(route));
    await on('**/api/tasks**', (route) => this.#tasks(route));
    await on('**/api/commands', (route) => this.#command(route));
    await on('**/api/linked-note**', (route) => this.#linkedNote(route));
    await on('**/api/training', (route) => this.session === 'signed-out' ? route.fulfill({ status: 401, body: '' }) : this.#json(route, 200, TrainingResponse.parse({ status: 'ok', revision: this.#revision, blobSha: this.blobSha, rows: this.trainingRows, unknownLines: this.trainingUnknownLines })));
    await on('**/api/active-work', (route) => this.#activeWork(route));
    await on('**/api/triage', (route) => this.session === 'signed-out' ? route.fulfill({ status: 401, body: '' })
      : this.#json(route, 200, TriageResponse.parse({ ...this.triage, revision: this.#revision })));
    await on('**/api/history', (route) => this.#history(route));
    await on('**/api/notes', (route) => this.#notes(route));
    await on('**/api/notes/read', (route) => this.#noteRead(route));
  }

  #history(route: Route) {
    if (this.session === 'signed-out') return route.fulfill({ status: 401, body: '' });
    const today: HistoryItem[] = this.doneToday.map((t) => ({ source: 'todo', description: t.description, doneDate: t.done ?? TODAY,
      locator: { ...t.locator, blobSha: this.blobSha }, links: t.links }));
    const items = [...today, ...this.olderHistory].sort((a, b) => b.doneDate.localeCompare(a.doneDate));
    return this.#json(route, 200, HistoryResponse.parse({ revision: this.#revision, today: TODAY, items }));
  }

  #notes(route: Route) {
    if (this.session === 'signed-out') return route.fulfill({ status: 401, body: '' });
    const notes = [...this.inboxNotes].map(([path, n]) => ({ path, title: n.title, date: n.date, blobSha: n.blobSha }))
      .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '') || a.title.localeCompare(b.title));
    return this.#json(route, 200, NotesResponse.parse({ revision: this.#revision, notes }));
  }

  #noteRead(route: Route) {
    if (this.session === 'signed-out') return route.fulfill({ status: 401, body: '' });
    // The path must arrive in the header only, never in the URL.
    if (new URL(route.request().url()).search !== '') throw new Error('mock: note read carried a query');
    const path = decodeNoteHeader(route.request().headers()[NOTE_HEADER.toLowerCase()]);
    if (path === null) return this.#json(route, 400, ApiError.parse({ code: 'invalid', message: 'invalid note path', retryable: false }));
    const n = this.inboxNotes.get(path);
    return this.#json(route, 200, NoteReadResponse.parse(n
      ? { status: 'ok', revision: this.#revision, path, blobSha: n.blobSha, markdown: n.frontmatter + n.body, frontmatter: n.frontmatter, body: n.body }
      : { status: 'refused', revision: this.#revision, code: 'not-found', message: 'the note does not exist any more; reload the list' }));
  }

  #json(route: Route, status: number, body: unknown) {
    return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  }

  /** Answers a read that is not `ok`; false means serve it normally. */
  async #readFailure(route: Route, mode: ReadMode): Promise<boolean> {
    if (mode === 'ok') return false;
    if (mode === 'offline') await route.abort('internetdisconnected');
    else if (mode === 'error') await route.fulfill({ status: 502, body: 'Bad gateway' });
    // `hang`: never answered; the page aborts it.
    return true;
  }

  async #session(route: Route) {
    if (await this.#readFailure(route, this.sessionMode)) return;
    if (this.session === 'signed-out') return route.fulfill({ status: 401, body: '' });
    return this.#json(route, 200, SessionResponse.parse({ accountKey: this.account }));
  }

  #activeWork(route: Route) {
    if (this.session === 'signed-out') return route.fulfill({ status: 401, body: '' });
    if (this.activeWork === 'error') {
      return this.#json(route, 503, ApiError.parse({ code: 'upstream-unavailable', message: 'GitHub is unavailable.', retryable: true }));
    }
    const body = this.activeWork === null
      ? { status: 'absent', revision: this.#revision }
      : { status: 'ok', revision: this.#revision, blobSha: '5'.repeat(40), markdown: this.activeWork, items: this.activeWorkItems, unknownNowLines: this.unknownNowLines, today: TODAY };
    return this.#json(route, 200, ActiveWorkResponse.parse(body));
  }

  #linkedNote(route: Route) {
    if (this.session === 'signed-out') return route.fulfill({ status: 401, body: '' });
    const request = route.request();
    const req = decodeLinkedNoteHeader(request.headers()[LINKED_NOTE_HEADER.toLowerCase()]);
    if (!req) return this.#json(route, 400, ApiError.parse({ code: 'invalid', message: 'invalid linked-note request', retryable: false }));
    this.noteRequests.push({ req, url: request.url() });
    const task = [...this.open, ...this.doneToday].find((t) => t.locator.lineText === req.taskLocator.lineText);
    const target = task?.links[req.linkIndex];
    const note = target === undefined ? undefined : this.notes.get(target);
    const body = note
      ? { status: 'ok', revision: this.#revision, path: note.path, blobSha: '4'.repeat(40), markdown: note.markdown }
      : { status: 'refused', revision: this.#revision, code: task ? 'not-found' : 'task-changed', message: 'refused' };
    return this.#json(route, 200, LinkedNoteResponse.parse(body));
  }

  async #tasks(route: Route) {
    this.taskReads += 1;
    if (await this.#readFailure(route, this.tasksMode)) return;
    if (this.session === 'signed-out') return route.fulfill({ status: 401, body: '' });
    const asked = new URL(route.request().url()).searchParams.get('known')?.split(',').filter(Boolean) ?? [];
    this.maxKnownAsked = Math.max(this.maxKnownAsked, asked.length);
    // After a history rewrite no earlier commit is on main any more (review O6).
    const known = Object.fromEntries(asked.map((c) => [c, this.#rewritten ? ('not-included' as const) : ('included' as const)]));
    // Locators as the Worker builds them: this read's blob, and how many indexed lines share the text.
    const lines = [...this.open, ...this.doneToday].map((t) => t.locator.lineText);
    const located = (t: TaskView): TaskView => ({
      ...t,
      locator: {
        ...t.locator,
        blobSha: this.blobSha,
        occurrencesAtRead: lines.filter((l) => l === t.locator.lineText).length,
      },
    });
    const open = this.open.map(located);
    const body = TasksResponse.parse({
      revision: this.#revision,
      blobSha: this.blobSha,
      today: TODAY,
      timeZone: 'Europe/Copenhagen',
      vault: this.vault,
      writeBlock: this.writeBlock,
      known,
      todayTasks: open.filter((t) => t.due === TODAY),
      overdue: open.filter((t) => t.due !== null && t.due < TODAY),
      allOpen: open,
      doneToday: this.doneToday.map(located),
    });
    return this.#json(route, 200, body);
  }

  async #command(route: Route) {
    const request = route.request();
    const raw = request.postData() ?? '';
    this.bodies.push(raw);
    if (request.headers()['x-vc-request'] !== '1') return this.#json(route, 403, { code: 'forbidden', message: 'x', retryable: false });
    const command = Command.parse(JSON.parse(raw));
    // Like the Worker: the item's account binding travels outside the body and must match the session (A7).
    if (request.headers()['x-vc-account'] !== this.account) {
      return this.#json(route, 409, ApiError.parse({ code: 'account-mismatch', message: 'Other account.', retryable: false }));
    }

    const mode = this.commandMode;
    if (mode === 'hold') await new Promise<void>((resolve) => this.#held.push(resolve));
    if (mode === 'offline') return route.abort('internetdisconnected');
    if (mode === 'unavailable') {
      return this.#json(route, 503, ApiError.parse({ code: 'upstream-unavailable', message: 'GitHub is unavailable.', retryable: true }));
    }
    if (typeof mode === 'object') return this.#json(route, 409, ApiError.parse({ ...mode.refuse, operationId: command.operationId }));

    // Like the Worker (ADR-0013): an Undo's token must be its completion's commit.
    if ((command.type === 'UndoCompleteTask' || command.type === 'UndoActiveWork') && this.#receipts.get(command.payload.target.operationId)?.commitSha !== command.payload.targetCommit) {
      return this.#json(route, 400, ApiError.parse({ code: 'invalid', message: 'Undo target does not match.', retryable: false }));
    }
    const previous = this.#receipts.get(command.operationId);
    if (previous) return this.#json(route, 200, { ...previous, status: 'already-applied' });
    const receipt = Receipt.parse(this.#apply(command));
    this.#receipts.set(command.operationId, receipt);
    this.applied.push(command);
    return this.#json(route, 200, receipt);
  }

  /** A desktop commit to the task list: new revision and blob, these open tasks. */
  desktopEdit(open: TaskView[]): void {
    this.#revision = sha();
    this.blobSha = sha();
    this.open = open;
  }

  /** Someone force-pushed main: new head, and none of the earlier commits is an ancestor of it any more (O6). */
  rewriteHistory(): void {
    this.#revision = sha();
    this.#rewritten = true;
  }

  /** Answer every held request (as `ok`) and stop holding new ones. */
  release(): void {
    this.commandMode = 'ok';
    for (const resolve of this.#held.splice(0)) resolve();
  }

  get heldCount(): number {
    return this.#held.length;
  }

  #apply(command: Command): Receipt {
    this.#revision = sha();
    const base = { operationId: command.operationId, status: 'applied' as const, commitSha: this.#revision, blobSha: sha() };
    if (command.type !== 'CaptureNote' && command.type !== 'EditNote') this.blobSha = base.blobSha;
    switch (command.type) {
      case 'LogTraining': {
        const s = command.payload.session;
        this.#trainingBefore.set(command.operationId, structuredClone(this.trainingRows));
        const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Copenhagen', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(s.when));
        this.trainingRows.push({ date: copenhagenDay(s.when), time: parts, type: s.type, distance: s.type === 'Run' ? s.distance.toFixed(1) : '', duration: String(s.duration), weight: s.type === 'Gym' && s.weight !== undefined ? s.weight.toFixed(1) : '', split: s.type === 'Gym' ? s.split : '', note: s.note ?? '' });
        this.trainingRows.sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time));
        return { ...base, path: 'Health/Training Log.md', effect: { kind: 'training', op: 'logged', lineText: '| synthetic session |' } };
      }
      case 'UndoLogTraining': {
        const before = this.#trainingBefore.get(command.payload.target.operationId);
        if (!before) throw new Error('mock: unknown training undo');
        this.trainingRows = before;
        return { ...base, path: 'Health/Training Log.md', effect: { kind: 'training', op: 'undone', lineText: '| synthetic session |' } };
      }
      case 'TriageDecide': {
        const { eventId, decision, undoes } = command.payload;
        this.triage.decisions.push({ decisionId: command.operationId, eventId, decision, undoes, at: command.occurredAt });
        const path = `Events/Triage/Decisions/${copenhagenDay(command.occurredAt).slice(0, 7)}.jsonl`;
        return { ...base, path, effect: { kind: 'triage-decided', path, decisionId: command.operationId } };
      }
      case 'CaptureActiveWork': {
        const p = command.payload;
        const lineText = '- [ ] **' + p.name + ':**' + (p.next ? ' Next: ' + p.next : '') + (p.review ? ' ⏳ ' + p.review : '') + (p.link ? ' ' + p.link : '');
        this.activeWork ??= '## Now';
        this.activeWorkItems.push({ name: p.name, outcome: null, next: p.next ?? null, review: p.review ?? null,
          link: p.link ?? null, needsReview: !!p.review && p.review < TODAY,
          locator: { path: 'Tasks/Active Work Now.md', blobSha: base.blobSha, lineIndex: 10 + this.activeWorkItems.length, lineText, occurrencesAtRead: 1 } });
        return { ...base, path: 'Tasks/Active Work Now.md', effect: { kind: 'active-work', op: 'captured', beforeLineText: null, afterLineText: lineText } };
      }
      case 'ReviewActiveWork':
      case 'EditActiveWork': {
        const p = command.payload;
        const item = this.activeWorkItems.find((i) => i.locator.lineText === p.item.lineText && i.locator.lineIndex === p.item.lineIndex);
        if (!item) throw new Error('mock: unknown active work item');
        this.#awBefore.set(command.operationId, structuredClone(this.activeWorkItems));
        let afterLineText: string | null = null;
        if (command.type === 'EditActiveWork') {
          Object.assign(item, command.payload.changes);
        } else if (command.payload.action === 'keep') {
          item.review = '2026-10-01'; item.needsReview = false;
        } else {
          this.activeWorkItems = this.activeWorkItems.filter((i) => i !== item);
        }
        if (this.activeWorkItems.includes(item)) {
          afterLineText = '- [ ] **' + item.name + ':**' + (item.next ? ' Next: ' + item.next : '') + (item.review ? ' ⏳ ' + item.review : '') + (item.link ? ' ' + item.link : '');
          item.locator = { ...item.locator, lineText: afterLineText, blobSha: base.blobSha };
        }
        return { ...base, path: p.item.path, effect: { kind: 'active-work', op: command.type === 'EditActiveWork' ? 'edited' : command.payload.action,
          beforeLineText: p.item.lineText, afterLineText } };
      }
      case 'UndoActiveWork': {
        const before = this.#awBefore.get(command.payload.target.operationId);
        if (!before) throw new Error('mock: unknown active work undo');
        this.activeWorkItems = structuredClone(before);
        return { ...base, path: 'Tasks/Active Work Now.md', effect: { kind: 'active-work', op: 'undone', beforeLineText: null, afterLineText: command.payload.target.payload.item.lineText } };
      }
      case 'EditTask': {
        const { task: locator, changes } = command.payload;
        const same = this.open.filter((t) => t.locator.lineText === locator.lineText);
        const task = same.find((t) => t.locator.lineIndex === locator.lineIndex) ?? (same.length === 1 ? same[0] : undefined);
        if (!task) throw new Error('mock: editing an unknown task');
        const pick = <T,>(v: T | undefined, old: T): T => (v === undefined ? old : v);
        const updated = { description: changes.text ?? task.description, due: pick(changes.due, task.due),
          scheduled: pick(changes.scheduled, task.scheduled), priority: pick(changes.priority, task.priority) };
        const icons = { highest: '🔺', high: '⏫', medium: '🔼', low: '🔽', lowest: '⏬' };
        const afterLineText = ['- [ ]', updated.description, updated.priority ? icons[updated.priority] : '',
          updated.scheduled ? '⏳ ' + updated.scheduled : '', updated.due ? '📅 ' + updated.due : ''].filter(Boolean).join(' ');
        // Keep the wire TaskView strict: text is a changes field, not a TaskView field.
        this.open = this.open.map((t) => t === task ? { ...task, description: updated.description,
          due: updated.due, scheduled: updated.scheduled, priority: updated.priority,
          locator: { ...task.locator, blobSha: base.blobSha, lineText: afterLineText } } : t);
        return { ...base, path: locator.path, effect: { kind: 'edited', beforeLineText: locator.lineText, afterLineText } };
      }
      case 'CompleteTask': {
        const { lineText, lineIndex } = command.payload.task;
        // The line the locator names (identical lines are different tasks), else the only one with its text.
        const same = this.open.filter((t) => t.locator.lineText === lineText);
        const task = same.find((t) => t.locator.lineIndex === lineIndex) ?? (same.length === 1 ? same[0] : undefined);
        if (!task) throw new Error('mock: completing an unknown task');
        const completedLineText = `${lineText.replace('- [ ]', '- [x]')} ✅ ${TODAY}`;
        this.open = this.open.filter((t) => t !== task);
        this.doneToday.unshift({
          ...task,
          locator: { ...task.locator, lineText: completedLineText, lineIndex: 40 + this.doneToday.length },
          status: 'done',
          section: 'done',
          done: TODAY,
        });
        return {
          ...base,
          path: 'Tasks/To-Do List.md',
          effect: { kind: 'completed', completedLineText, openLineText: lineText, completedInPlace: false, doneDate: TODAY },
        };
      }
      case 'UndoCompleteTask': {
        const { lineText } = command.payload.target.payload.task;
        const done = this.doneToday.find((t) => t.locator.lineText.startsWith(lineText.replace('- [ ]', '- [x]')));
        if (!done) throw new Error('mock: undoing an unknown completion');
        this.doneToday = this.doneToday.filter((t) => t !== done);
        this.open.push({ ...done, locator: command.payload.target.payload.task, status: 'open', section: 'open', done: null });
        return { ...base, path: 'Tasks/To-Do List.md', effect: { kind: 'reopened', openLineText: lineText } };
      }
      case 'CaptureTask': {
        const lineText = `- [ ] ${command.payload.text}`;
        this.open.push(taskView(90 + this.open.length, command.payload.text, { due: null }));
        return { ...base, path: 'Tasks/To-Do List.md', effect: { kind: 'task-captured', lineText } };
      }
      case 'CaptureNote': {
        const path = 'Inbox/Synthetic note - 2026-09-24.md';
        this.inboxNotes.set(path, { title: 'Synthetic note', date: TODAY, blobSha: base.blobSha, frontmatter: '---\ntype: inbox-note\n---\n', body: command.payload.text + '\n' });
        return { ...base, path, effect: { kind: 'note-captured', path } };
      }
      case 'EditNote': {
        const { note, body } = command.payload;
        const n = this.inboxNotes.get(note.path);
        if (!n) throw new Error('mock: editing an unknown note');
        this.noteEdits.push({ path: note.path, blobSha: note.blobSha, body });
        this.inboxNotes.set(note.path, { ...n, blobSha: base.blobSha, body: body.endsWith('\n') ? body : body + '\n' });
        return { ...base, path: note.path, effect: { kind: 'note-edited', path: note.path } };
      }
    }
  }
}
