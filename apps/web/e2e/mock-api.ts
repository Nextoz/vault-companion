// In-page API mock for Playwright. Every response is parsed through the contract schema before it is served,
// so a mock that drifts from packages/contracts fails loudly instead of testing a fiction.
import {
  ActiveWorkResponse,
  ApiError,
  Command,
  decodeLinkedNoteHeader,
  LINKED_NOTE_HEADER,
  LinkedNoteResponse,
  type LinkedNoteRequest,
  Receipt,
  SessionResponse,
  TasksResponse,
  type TaskView,
} from '@vault-companion/contracts';
import type { BrowserContext, Page, Route } from '@playwright/test';

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
  session: 'ok' | 'signed-out' = 'ok';
  /** The account the session reports (switch it to simulate signing in as someone else). */
  account = ACCOUNT;
  /** `down`: every request fails as a network error and is not recorded (it never reached the server). */
  network: 'up' | 'down' = 'up';
  sessionMode: ReadMode = 'ok';
  tasksMode: ReadMode = 'ok';
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
  readonly noteRequests: { req: LinkedNoteRequest; url: string }[] = [];
  readonly #receipts = new Map<string, Receipt>();
  #held: (() => void)[] = [];
  #revision = sha();

  /** Route a page, or a whole context: only a context route also sees requests made by a service worker. */
  async install(target: Page | BrowserContext): Promise<void> {
    const on = (glob: string, handle: (route: Route) => Promise<void>) =>
      target.route(glob, (route) => (this.network === 'down' ? route.abort('internetdisconnected') : handle(route)));
    await on('**/api/session', (route) => this.#session(route));
    await on('**/api/tasks**', (route) => this.#tasks(route));
    await on('**/api/commands', (route) => this.#command(route));
    await on('**/api/linked-note**', (route) => this.#linkedNote(route));
    await on('**/api/active-work', (route) => this.#activeWork(route));
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
      : { status: 'ok', revision: this.#revision, blobSha: '5'.repeat(40), markdown: this.activeWork };
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
    if (command.type === 'UndoCompleteTask' && this.#receipts.get(command.payload.target.operationId)?.commitSha !== command.payload.targetCommit) {
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
    if (command.type !== 'CaptureNote') this.blobSha = base.blobSha;
    switch (command.type) {
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
      case 'CaptureNote':
        return { ...base, path: 'Inbox/Synthetic note.md', effect: { kind: 'note-captured', path: 'Inbox/Synthetic note.md' } };
    }
  }
}
