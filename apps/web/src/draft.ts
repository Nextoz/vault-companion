// Capture draft recovery (P4-C): unfinished Capture text kept on this device, one draft per account, apart from the
// pending queue. A draft is never a command: nothing here sends. Every write is a compare-and-swap on the draft
// version this instance started from (`DraftBasis`), so with several app instances open a stale or late write can
// neither overwrite a newer draft nor bring back one that was saved or discarded; and Save enqueues the command and
// deletes the draft in one transaction that checks that version (`PendingStore.add`). Draft text is never logged.
import type { CaptureKind } from './prefs.ts';
import type { DraftBasis, PendingStore } from './queue/db.ts';

export type DraftStore = Pick<PendingStore, 'draft' | 'putDraft' | 'deleteDraft'>;

export interface DraftContent {
  kind: CaptureKind;
  text: string;
}

/**
 * - `kept`: the text is (or will be) kept as this account's draft.
 * - `unavailable`: storage failed (IndexedDB unavailable, quota, private mode); typing and Save still work.
 * - `elsewhere`: another instance keeps a draft this one has not seen; this text is not kept, but may be saved.
 * - `superseded`: the draft this instance holds was changed, saved or discarded in another instance. Nothing more is
 *   written, and Save is refused by the store, so the same draft can never become a second command.
 */
export type DraftStatus = 'kept' | 'unavailable' | 'elsewhere' | 'superseded';

/** Typing pause after which the draft is written. `visibilitychange`/`pagehide` write at once. */
export const DRAFT_DELAY_MS = 500;

export interface DraftKeeperOptions {
  store: DraftStore;
  /** The account the sheet is bound to. `null` (never connected): nothing can be attributed, so nothing is kept. */
  accountKey: string | null;
  onStatus: (status: DraftStatus) => void;
  delayMs?: number;
  now?: () => number;
  newId?: () => string;
  setTimer?: (fn: () => void, ms: number) => () => void;
}

export class DraftKeeper {
  readonly #store: DraftStore;
  readonly #accountKey: string | null;
  readonly #onStatus: (status: DraftStatus) => void;
  readonly #delayMs: number;
  readonly #now: () => number;
  readonly #newId: () => string;
  readonly #setTimer: NonNullable<DraftKeeperOptions['setTimer']>;
  /** The stored draft version this instance last read or wrote. Every write and Save is conditional on it. */
  #basis: DraftBasis = null;
  #updatedAt = 0;
  #pending: DraftContent | null = null;
  #cancelTimer: (() => void) | null = null;
  /** Set while Save runs and after it succeeded, or after `dispose`: no draft write may start. */
  #stopped = false;
  #superseded = false;
  /** Until `restore` has answered, changes wait: the basis is not known yet. */
  #restored = false;
  /** Writes run one at a time: each one's basis is the result of the one before. */
  #chain: Promise<void> = Promise.resolve();

  constructor(options: DraftKeeperOptions) {
    this.#store = options.store;
    this.#accountKey = options.accountKey;
    this.#onStatus = options.onStatus;
    this.#delayMs = options.delayMs ?? DRAFT_DELAY_MS;
    this.#now = options.now ?? Date.now;
    this.#newId = options.newId ?? (() => crypto.randomUUID());
    this.#setTimer =
      options.setTimer ??
      ((fn, ms) => {
        const id = setTimeout(fn, ms);
        return () => clearTimeout(id);
      });
  }

  /** The version Save must find still stored (`EnqueueOptions.draft`). Read after `suspend`. */
  get basis(): DraftBasis {
    return this.#basis;
  }

  get superseded(): boolean {
    return this.#superseded;
  }

  /** This account's draft, if any. Another account's draft is never read, let alone returned or deleted. */
  async restore(): Promise<DraftContent | null> {
    if (this.#accountKey === null) {
      this.#restored = true;
      return null;
    }
    try {
      const draft = await this.#store.draft(this.#accountKey);
      if (!draft || draft.accountKey !== this.#accountKey) return null;
      this.#basis = { id: draft.id, version: draft.version };
      this.#updatedAt = draft.updatedAt;
      return draft.text.length > 0 ? { kind: draft.kind, text: draft.text } : null;
    } catch {
      this.#onStatus('unavailable');
      return null;
    } finally {
      this.#restored = true;
      if (this.#pending) this.#schedule();
    }
  }

  /** The sheet's text or type changed: written after a pause in typing. Never sends anything. */
  change(content: DraftContent): void {
    if (this.#stopped || this.#superseded || this.#accountKey === null) return;
    this.#pending = content;
    if (this.#restored) this.#schedule();
  }

  /** Write any pending change now (`visibilitychange`, `pagehide`, closing the sheet). */
  flush(): Promise<void> {
    this.#cancelTimer?.();
    this.#cancelTimer = null;
    const content = this.#pending;
    if (!content || this.#stopped || !this.#restored || this.#accountKey === null) return this.#chain;
    this.#pending = null;
    return this.#enqueueWrite(() => this.#write(content));
  }

  /** The explicit "Discard draft": forget pending changes and delete the stored draft, if it is still ours. */
  discard(): Promise<void> {
    this.#cancelTimer?.();
    this.#cancelTimer = null;
    this.#pending = null;
    return this.#enqueueWrite(() => this.#write({ kind: 'task', text: '' }));
  }

  /**
   * Save is starting: no draft write may start from now on, and every write already started has finished, so
   * `basis` is final. The caller then enqueues with `draft: basis`.
   */
  async suspend(): Promise<void> {
    this.#cancelTimer?.();
    this.#cancelTimer = null;
    this.#pending = null;
    this.#stopped = true;
    await this.#chain;
  }

  /** Save failed (storage error): the text is still in the sheet and in the stored draft; keep following it. */
  resume(content: DraftContent): void {
    this.#stopped = false;
    this.change(content);
  }

  /** Save found the draft changed or gone: stop writing for good. */
  supersede(): void {
    this.#stopped = true;
    this.#setSuperseded();
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

  #enqueueWrite(run: () => Promise<void>): Promise<void> {
    this.#chain = this.#chain.then(run, run);
    return this.#chain;
  }

  async #write(content: DraftContent): Promise<void> {
    const accountKey = this.#accountKey;
    if (accountKey === null || this.#superseded) return;
    const basis = this.#basis;
    try {
      if (content.text.length === 0) {
        if (basis === null) return;
        if ((await this.#store.deleteDraft(accountKey, basis)) === 'conflict') return this.#setSuperseded();
        this.#basis = null;
        return;
      }
      // Never older than the version it follows, even if the clock stepped back.
      const updatedAt = Math.max(this.#now(), this.#updatedAt);
      const next = {
        accountKey,
        id: basis?.id ?? this.#newId(),
        version: (basis?.version ?? 0) + 1,
        kind: content.kind,
        text: content.text,
        updatedAt,
      };
      if ((await this.#store.putDraft(next, basis)) === 'conflict') {
        if (basis === null) return this.#onStatus('elsewhere');
        return this.#setSuperseded();
      }
      this.#basis = { id: next.id, version: next.version };
      this.#updatedAt = updatedAt;
      this.#onStatus('kept');
    } catch {
      this.#onStatus('unavailable');
    }
  }

  #setSuperseded(): void {
    this.#superseded = true;
    this.#pending = null;
    this.#onStatus('superseded');
  }
}
