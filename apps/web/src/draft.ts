// Capture draft recovery (P4-C): unfinished Capture text kept on this device, one draft per account, apart from the
// pending queue. A draft is never a command: nothing here sends, and Save removes it in the same IndexedDB
// transaction that enqueues the command (`PendingStore.add`). Draft text is never logged.
import type { CaptureKind } from './prefs.ts';
import type { PendingStore } from './queue/db.ts';

export type DraftStore = Pick<PendingStore, 'draft' | 'putDraft' | 'deleteDraft'>;

export interface DraftContent {
  kind: CaptureKind;
  text: string;
}

/** Typing pause after which the draft is written. `visibilitychange`/`pagehide` write at once. */
export const DRAFT_DELAY_MS = 500;

export interface DraftKeeperOptions {
  store: DraftStore;
  /** The account the sheet is bound to. `null` (never connected): nothing can be attributed, so nothing is kept. */
  accountKey: string | null;
  /** A draft read or write failed (IndexedDB unavailable, quota, private mode). Typing goes on regardless. */
  onUnavailable: () => void;
  delayMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => () => void;
}

export class DraftKeeper {
  readonly #store: DraftStore;
  readonly #accountKey: string | null;
  readonly #onUnavailable: () => void;
  readonly #delayMs: number;
  readonly #now: () => number;
  readonly #setTimer: NonNullable<DraftKeeperOptions['setTimer']>;
  #pending: DraftContent | null = null;
  #cancelTimer: (() => void) | null = null;
  /** Set while Save runs and after it succeeded, or after `dispose`: no draft write may start. */
  #stopped = false;
  /** Until `restore` has answered, changes wait: a debounced write must not replace the draft being restored. */
  #restored = false;
  readonly #writes = new Set<Promise<void>>();

  constructor(options: DraftKeeperOptions) {
    this.#store = options.store;
    this.#accountKey = options.accountKey;
    this.#onUnavailable = options.onUnavailable;
    this.#delayMs = options.delayMs ?? DRAFT_DELAY_MS;
    this.#now = options.now ?? Date.now;
    this.#setTimer =
      options.setTimer ??
      ((fn, ms) => {
        const id = setTimeout(fn, ms);
        return () => clearTimeout(id);
      });
  }

  /** This account's draft, if any. Another account's draft is never read, let alone returned or deleted. */
  async restore(): Promise<DraftContent | null> {
    if (this.#accountKey === null) {
      this.#restored = true;
      return null;
    }
    try {
      const draft = await this.#store.draft(this.#accountKey);
      return draft && draft.accountKey === this.#accountKey && draft.text.length > 0
        ? { kind: draft.kind, text: draft.text }
        : null;
    } catch {
      this.#onUnavailable();
      return null;
    } finally {
      this.#restored = true;
      if (this.#pending) this.#schedule();
    }
  }

  /** The sheet's text or type changed: written after a pause in typing. Never sends anything. */
  change(content: DraftContent): void {
    if (this.#stopped || this.#accountKey === null) return;
    this.#pending = content;
    if (this.#restored) this.#schedule();
  }

  /** Write any pending change now (`visibilitychange`, `pagehide`, closing the sheet). */
  flush(): Promise<void> {
    this.#cancelTimer?.();
    this.#cancelTimer = null;
    const content = this.#pending;
    const accountKey = this.#accountKey;
    if (!content || this.#stopped || !this.#restored || accountKey === null) return Promise.resolve();
    this.#pending = null;
    // The transaction is created synchronously here, so it is ordered before any later Save transaction.
    return this.#track(
      content.text.length === 0
        ? this.#store.deleteDraft(accountKey)
        : this.#store.putDraft({ accountKey, kind: content.kind, text: content.text, updatedAt: this.#now() }),
    );
  }

  /** The explicit "Discard draft": forget pending changes and delete the stored draft. */
  discard(): Promise<void> {
    this.#cancelTimer?.();
    this.#cancelTimer = null;
    this.#pending = null;
    if (this.#accountKey === null) return Promise.resolve();
    return this.#track(this.#store.deleteDraft(this.#accountKey));
  }

  /**
   * Save is starting: no draft write may start from now on, and every write already started has finished. The
   * caller then enqueues with `clearDraft`, which deletes the draft in the enqueue transaction.
   */
  async suspend(): Promise<void> {
    this.#cancelTimer?.();
    this.#cancelTimer = null;
    this.#pending = null;
    this.#stopped = true;
    await Promise.all(this.#writes);
  }

  /** Save failed: the text is still in the sheet and in the stored draft; keep following it. */
  resume(content: DraftContent): void {
    this.#stopped = false;
    this.change(content);
  }

  /** The sheet is going away: write what is pending, then stop. */
  dispose(): Promise<void> {
    const flushed = this.flush();
    this.#stopped = true;
    return flushed;
  }

  #schedule(): void {
    this.#cancelTimer?.();
    this.#cancelTimer = this.#setTimer(() => void this.flush(), this.#delayMs);
  }

  #track(write: Promise<void>): Promise<void> {
    const tracked = write.catch(() => this.#onUnavailable());
    this.#writes.add(tracked);
    void tracked.finally(() => this.#writes.delete(tracked));
    return tracked;
  }
}
