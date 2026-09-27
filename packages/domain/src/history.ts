// ADR-0021: completion history. Read-only projection of To-Do `## Done` and Active Work `## Dropped or done`.
import { ACTIVE_WORK_PATH, MAX_HISTORY_ITEMS, MAX_TASK_LINE, type ApiError, type HistoryItem, type HistoryResponse } from '@vault-companion/contracts';
import * as md from '@vault-companion/vault-markdown';
import { readTodo, toView } from './commands.ts';
import { StoreUnavailable, StoreUnknownOutcome, type VaultPath, type VaultStore } from './store.ts';
import { userDate } from './time.ts';

export interface HistoryServiceDeps {
  readonly store: VaultStore;
  readonly timeZone: string;
  readonly now: () => Date;
}

const ACTIVE = ACTIVE_WORK_PATH as VaultPath;
const apiError = (code: ApiError['code'], message: string): ApiError => ({ code, message, retryable: false });

async function read(store: VaultStore, today: string): Promise<HistoryResponse | ApiError> {
  const { commitSha: x } = await store.head();
  const todo = await readTodo(store, x);
  if (!todo.ok) {
    const p = todo.planned as Extract<typeof todo.planned, { ok: false }>;
    return apiError(p.code, p.message);
  }
  const parsed = md.parseTodoList(todo.text);
  if (!parsed.ok) return apiError(parsed.code, parsed.message);
  const items: HistoryItem[] = [];
  for (const t of parsed.tasks) {
    if (t.lineText.length > MAX_TASK_LINE) continue;
    const v = toView(t, todo.blobSha);
    // Cancelled (❌) is its own status; an undated done line has no day to group under.
    if (v.section !== 'done' || v.status !== 'done' || v.done === null) continue;
    items.push({ source: 'todo', description: v.description, doneDate: v.done, locator: v.locator, links: v.links });
  }

  // Absent Active Work contributes nothing; an unreadable one is refused like the To-Do List.
  const aw = await readTodo(store, x, ACTIVE);
  if (aw.ok) {
    const a = md.parseActiveWork(aw.text, today);
    if (!a.ok) return apiError(a.code, a.message);
    for (const t of a.doneItems) {
      // The trailing [[link]] stays in the text so the client's link segmentation (same target rule) can open it.
      const target = t.link?.slice(2, -2).split(/[|#]/)[0]!.trim();
      items.push({
        source: 'active-work',
        description: [t.outcome ? `${t.name}: ${t.outcome}` : t.name, t.link].filter(Boolean).join(' '),
        doneDate: t.done,
        locator: { path: ACTIVE_WORK_PATH, blobSha: aw.blobSha, lineIndex: t.lineIndex, lineText: t.lineText, occurrencesAtRead: t.occurrences },
        links: target ? [target] : [],
      });
    }
  } else {
    const p = aw.planned as Extract<typeof aw.planned, { ok: false }>;
    if (p.code !== 'refused:structure') return apiError(p.code, p.message);
  }

  // Array.prototype.sort is stable: file order (To-Do, then Active Work) survives within a day.
  items.sort((a, b) => (a.doneDate < b.doneDate ? 1 : a.doneDate > b.doneDate ? -1 : 0));
  return { revision: x, today, items: items.slice(0, MAX_HISTORY_ITEMS) };
}

export function createHistoryService(deps: HistoryServiceDeps) {
  return {
    async readHistory(): Promise<HistoryResponse | ApiError> {
      try {
        return await read(deps.store, userDate(deps.now(), deps.timeZone));
      } catch (e) {
        if (e instanceof StoreUnavailable || e instanceof StoreUnknownOutcome) {
          return { code: 'upstream-unavailable', message: 'GitHub is not reachable right now', retryable: true };
        }
        throw e;
      }
    },
  };
}
