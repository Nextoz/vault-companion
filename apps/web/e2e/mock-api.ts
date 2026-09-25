// In-page API mock for Playwright. Every response is parsed through the contract schema before it is served,
// so a mock that drifts from packages/contracts fails loudly instead of testing a fiction.
import {
  ApiError,
  Command,
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

export class MockApi {
  session: 'ok' | 'signed-out' = 'ok';
  /** `down`: every request fails as a network error and is not recorded (it never reached the server). */
  network: 'up' | 'down' = 'up';
  commandMode: CommandMode = 'ok';
  open: TaskView[] = [];
  doneToday: TaskView[] = [];
  /** Every POST body exactly as received, including failed attempts. */
  readonly bodies: string[] = [];
  readonly applied: Command[] = [];
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
  }

  #json(route: Route, status: number, body: unknown) {
    return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  }

  #session(route: Route) {
    if (this.session === 'signed-out') return route.fulfill({ status: 401, body: '' });
    return this.#json(route, 200, SessionResponse.parse({ accountKey: ACCOUNT }));
  }

  #tasks(route: Route) {
    if (this.session === 'signed-out') return route.fulfill({ status: 401, body: '' });
    const asked = new URL(route.request().url()).searchParams.get('known')?.split(',').filter(Boolean) ?? [];
    const known = Object.fromEntries(asked.map((c) => [c, 'included' as const]));
    const body = TasksResponse.parse({
      revision: this.#revision,
      blobSha: '2'.repeat(40),
      today: TODAY,
      timeZone: 'Europe/Copenhagen',
      writeBlock: null,
      known,
      todayTasks: this.open.filter((t) => t.due === TODAY),
      overdue: [],
      allOpen: this.open,
      doneToday: this.doneToday,
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
    if (request.headers()['x-vc-account'] !== ACCOUNT) {
      return this.#json(route, 409, ApiError.parse({ code: 'account-mismatch', message: 'Other account.', retryable: false }));
    }

    const mode = this.commandMode;
    if (mode === 'hold') await new Promise<void>((resolve) => this.#held.push(resolve));
    if (mode === 'offline') return route.abort('internetdisconnected');
    if (mode === 'unavailable') {
      return this.#json(route, 503, ApiError.parse({ code: 'upstream-unavailable', message: 'GitHub is unavailable.', retryable: true }));
    }
    if (typeof mode === 'object') return this.#json(route, 409, ApiError.parse({ ...mode.refuse, operationId: command.operationId }));

    const previous = this.#receipts.get(command.operationId);
    if (previous) return this.#json(route, 200, { ...previous, status: 'already-applied' });
    const receipt = Receipt.parse(this.#apply(command));
    this.#receipts.set(command.operationId, receipt);
    this.applied.push(command);
    return this.#json(route, 200, receipt);
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
    switch (command.type) {
      case 'CompleteTask': {
        const { lineText } = command.payload.task;
        const task = this.open.find((t) => t.locator.lineText === lineText);
        if (!task) throw new Error('mock: completing an unknown task');
        const completedLineText = `${lineText.replace('- [ ]', '- [x]')} ✅ ${TODAY}`;
        this.open = this.open.filter((t) => t !== task);
        this.doneToday.unshift({
          ...task,
          locator: { ...task.locator, lineText: completedLineText, lineIndex: 40 },
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
