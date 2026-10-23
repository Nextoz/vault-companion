// ADR-0067: instant XP. The phone adds a just-made action to the records of the last /api/game read and runs the same
// engine the Worker runs, so the celebration plays the moment you tap. The next server read confirms or corrects it
// quietly. Pure: no React, no storage, no network.
import type { Command, GameRecordWire, GameResponse } from '@vault-companion/contracts';
import { characterConfig, computeCharacter, gameFeedback, wireCharacter } from '@vault-companion/domain/game';
import { isComplete } from './rewards.ts';

/** The calendar date of an instant in a zone, as the Worker's `userDate` computes it. */
export function dateIn(instant: string | Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(instant));
  const part = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/** Training rows are always written in Copenhagen wall time (`formatTrainingRow`), whatever the user zone is. */
const TRAINING_ZONE = 'Europe/Copenhagen';

/**
 * The record a command will add once it saves, shaped exactly like the Worker's slim record for that row; null when
 * the command earns nothing (or its effect cannot be known before the server applies it, like an edit or an undo).
 * Ids are local placeholders: the engine uses them only to tell records apart.
 */
export function recordFor(command: Command, timeZone: string): GameRecordWire | null {
  const id = `local:${command.operationId}`;
  switch (command.type) {
    case 'LogTraining': {
      const s = command.payload.session;
      return { source: 'training', date: dateIn(s.when, TRAINING_ZONE), type: s.type, duration: `${s.duration} min` };
    }
    case 'LogLearning': {
      const s = command.payload.session;
      return { source: 'learning', date: s.date, kind: s.kind, minutes: s.minutes === undefined ? '' : String(s.minutes), ...(s.topic ? { topic: s.topic } : {}) };
    }
    // The server dates a completion by the command's own `occurredAt`, in the user zone.
    case 'CompleteTask': return { source: 'task', date: dateIn(command.occurredAt, timeZone), id, overdueDays: 0 };
    case 'ReviewActiveWork': return command.payload.action === 'done' ? { source: 'quest', date: dateIn(command.occurredAt, timeZone), id } : null;
    case 'SaveReflection': return { source: 'reflection', date: command.payload.date, id };
    default: return null;
  }
}

/** The operation an Undo command takes back, so its predicted record can be dropped before it ever saves. */
export function undoTarget(command: Command): string | null {
  const payload = command.payload as { target?: { operationId?: unknown } };
  return command.type.startsWith('Undo') && typeof payload.target?.operationId === 'string' ? payload.target.operationId : null;
}

/** The parts of a queue item the ledger reads (a structural subset of `QueueItem`). */
export interface LedgerItem {
  readonly operationId: string;
  readonly state: 'pending' | 'saving' | 'saved' | 'attention';
  readonly envelope: Command;
  readonly accountKey: string;
  readonly accountMismatch: boolean;
  readonly acknowledged: boolean;
}

/** Records compare by content, never by id: a predicted record has a local id, its saved row a vault one. */
const contentKey = (r: GameRecordWire): string => JSON.stringify([r.source, r.date, r.type ?? '', r.duration ?? '', r.kind ?? '', r.minutes ?? '', r.topic ?? '']);
function countKeys(records: readonly GameRecordWire[] | undefined): Map<string, number> {
  const counts = new Map<string, number>();
  for (const r of records ?? []) counts.set(contentKey(r), (counts.get(contentKey(r)) ?? 0) + 1);
  return counts;
}

/**
 * Which queued actions are predicted and not yet visible in a server read (ADR-0067). Pure bookkeeping, so every
 * path (Undo, a refusal, a local cancel, a read that lags the commit) is unit-tested without React.
 *
 * - A prediction is made once, for an action first seen unsaved. One first seen saved may already be in the read.
 * - It ends when a read shows a matching new record (content evidence, not timing), when a read starts after the
 *   queue acknowledged its commit, when the action is refused, or when it leaves the queue unsaved (cancelled).
 * - An Undo removes its target's prediction at once. Until the Undo itself is saved and read, server reads may still
 *   show the target, so the layer stays `quiet` (no celebration from reads). A refused Undo restores the prediction.
 */
export class PredictionLedger {
  #considered = new Set<string>();
  #predicted = new Map<string, GameRecordWire>();
  #saved = new Set<string>();
  /** Undo id -> its target and the target's prediction (null once a read shows the target: nothing to restore). */
  #undos = new Map<string, { readonly target: string; record: GameRecordWire | null }>();

  /** Applies a queue snapshot. `gain`: a new prediction was added (celebrate); otherwise any change is silent. */
  observe(items: readonly LedgerItem[], account: string, timeZone: string | null): { changed: boolean; gain: boolean } {
    let changed = false;
    let gain = false;
    const present = new Set(items.map((i) => i.operationId));
    for (const item of items) {
      const id = item.operationId;
      if (item.state === 'saved') this.#saved.add(id);
      if (!this.#considered.has(id)) {
        this.#considered.add(id);
        if ((item.state !== 'pending' && item.state !== 'saving') || item.accountMismatch || item.accountKey !== account || timeZone === null) continue;
        const target = undoTarget(item.envelope);
        if (target !== null) {
          this.#undos.set(id, { target, record: this.#predicted.get(target) ?? null });
          changed = this.#predicted.delete(target) || changed;
          continue;
        }
        const record = recordFor(item.envelope, timeZone);
        if (record !== null) { this.#predicted.set(id, record); changed = gain = true; }
      } else if (item.state === 'attention') {
        changed = this.#predicted.delete(id) || changed;
        changed = this.#restore(id) || changed;
      }
    }
    // An Undo that left the queue unsaved never happens: its target's prediction comes back (if the target is still here).
    for (const id of [...this.#undos.keys()]) if (!present.has(id) && !this.#saved.has(id)) changed = this.#restore(id) || changed;
    // An action that left the queue unsaved was cancelled or discarded: it will never be in a read.
    for (const id of [...this.#predicted.keys()]) if (!present.has(id) && !this.#saved.has(id)) { this.#predicted.delete(id); changed = true; }
    return { changed, gain };
  }

  #restore(undoId: string): boolean {
    const undo = this.#undos.get(undoId);
    if (!undo) return false;
    this.#undos.delete(undoId);
    if (undo.record === null) return false;
    this.#predicted.set(undo.target, undo.record);
    return true;
  }

  /**
   * After a read with a new revision: drop predictions the read shows (a record whose content `previous` had fewer
   * of), then those whose commit the queue had acknowledged before the read started; settle Undos that were saved
   * before it started, and forget the restore of an undone target the read already shows.
   */
  settle(previous: GameResponse, next: GameResponse, savedBefore: ReadonlySet<string>, acknowledgedBefore: ReadonlySet<string>): void {
    const before = countKeys(previous.records);
    const added = new Map([...countKeys(next.records)].map(([key, n]) => [key, n - (before.get(key) ?? 0)] as const));
    for (const [id, record] of [...this.#predicted]) {
      const key = contentKey(record);
      if ((added.get(key) ?? 0) > 0) { added.set(key, added.get(key)! - 1); this.#predicted.delete(id); }
      else if (acknowledgedBefore.has(id)) this.#predicted.delete(id);
    }
    for (const [id, undo] of [...this.#undos]) {
      if (savedBefore.has(id)) { this.#undos.delete(id); continue; }
      const key = undo.record === null ? null : contentKey(undo.record);
      if (key !== null && (added.get(key) ?? 0) > 0) { added.set(key, added.get(key)! - 1); undo.record = null; }
    }
  }

  /**
   * Every action this ledger has seen saved, including ones whose receipt has since left the queue. A read started
   * after this snapshot settles Undos from it, so `quiet` cannot outlive an Undo whose first read failed.
   */
  savedSnapshot(): ReadonlySet<string> { return new Set(this.#saved); }

  /** An Undo is not reflected in a read yet: reads may still show its target, which was already celebrated. */
  get quiet(): boolean { return this.#undos.size > 0; }

  records(): GameRecordWire[] { return [...this.#predicted.values()]; }

  clear(): void { this.#considered.clear(); this.#predicted.clear(); this.#saved.clear(); this.#undos.clear(); }
}

let predictions = 0;

/**
 * `base` plus `extra` records, as the Worker would answer after they save. Null when the read cannot be extended
 * safely: an older Worker without records, a partial read (missing XP would look like a loss), or a rules change
 * this phone's bundle does not know yet.
 */
export function predictGame(base: GameResponse, extra: readonly GameRecordWire[], now: Date): GameResponse | null {
  if (!base.records || !base.timeZone || !isComplete(base) || base.character.rulesVersion !== characterConfig.rulesVersion) return null;
  if (extra.length === 0) return base;
  const character = computeCharacter([...base.records, ...extra], characterConfig, dateIn(now, base.timeZone));
  // A distinct revision per prediction: the reward diff treats an unchanged revision as "nothing happened".
  return { ...base, revision: `${base.revision}~${++predictions}`, character: wireCharacter(character), feedback: gameFeedback(character, characterConfig), records: [...base.records, ...extra] };
}
