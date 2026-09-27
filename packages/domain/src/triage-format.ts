// Pure JSON/JSONL kernel. Kept with domain because these formats use the shared triage contract.
import { TriageCard, TriageDecidePayload, TriageResponse, type Command } from '@vault-companion/contracts';

type Decide = Extract<Command, { type: 'TriageDecide' }>;
export type DecisionLine = Decide['payload'] & { schemaVersion: 1; decisionId: string; at: string };
const instant = TriageResponse.shape.now;
function json(text: string): unknown { try { return JSON.parse(text); } catch { return null; } }
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }

export function parseTriageFeed(text: string | null) {
  const empty = { generatedAt: null, cards: [] as TriageCard[], droppedCards: 0 };
  if (text === null) return { ...empty, feedState: 'absent' as const };
  const value = json(text);
  if (!object(value) || value.schemaVersion !== 1 || !instant.safeParse(value.generatedAt).success || !Array.isArray(value.cards)) {
    return { ...empty, feedState: 'unreadable' as const };
  }
  const cards: TriageCard[] = [];
  let droppedCards = 0;
  for (const raw of value.cards) {
    const card = TriageCard.safeParse(raw);
    if (card.success && cards.length < 500) cards.push(card.data);
    else droppedCards++;
  }
  return { feedState: 'ok' as const, generatedAt: value.generatedAt as string, cards, droppedCards };
}

export function parseTriageApplied(text: string | null): Pick<TriageResponse, 'applied' | 'appliedUpdatedAt'> {
  const value = json(text ?? '');
  const applied: TriageResponse['applied'] = {};
  if (!object(value) || value.schemaVersion !== 1 || !instant.safeParse(value.updatedAt).success || !object(value.decisions)) {
    return { applied, appliedUpdatedAt: null };
  }
  for (const [id, raw] of Object.entries(value.decisions)) {
    if (!TriageResponse.shape.decisions.element.shape.decisionId.safeParse(id).success || !object(raw)) continue;
    const status = TriageResponse.shape.applied.valueType.strip().safeParse(raw);
    if (status.success) applied[id] = status.data;
  }
  return { applied, appliedUpdatedAt: value.updatedAt as string };
}

export function parseDecisionLines(text: string | null): DecisionLine[] {
  const lines: DecisionLine[] = [];
  for (const raw of (text ?? '').split('\n')) {
    const value = json(raw);
    if (!object(value) || value.schemaVersion !== 1) continue;
    const summary = TriageResponse.shape.decisions.element.strip().safeParse(value);
    const payload = TriageDecidePayload.safeParse({ eventId: value.eventId, decision: value.decision, reason: value.reason,
      undoes: value.undoes, explore: value.explore, card: value.card });
    if (summary.success && payload.success) lines.push({ schemaVersion: 1, ...payload.data, decisionId: summary.data.decisionId, at: summary.data.at });
  }
  return lines;
}

/** Also finds an ID in an otherwise malformed object: never append a second copy of that ID. */
export function hasDecisionId(text: string | null, id: string): boolean {
  return (text ?? '').split('\n').some((line) => { const value = json(line); return object(value) && value.decisionId === id; });
}

export function appendDecisionLine(text: string | null, line: DecisionLine): Uint8Array {
  const { title, category, sourceName, aiScore, start } = line.card;
  const ordered = { schemaVersion: 1, decisionId: line.decisionId, eventId: line.eventId, decision: line.decision,
    reason: line.reason, undoes: line.undoes, explore: line.explore, at: line.at, card: { title, category, sourceName, aiScore, start } };
  const prefix = text ?? '';
  return new TextEncoder().encode(prefix + (prefix && !prefix.endsWith('\n') ? '\n' : '') + JSON.stringify(ordered) + '\n');
}
