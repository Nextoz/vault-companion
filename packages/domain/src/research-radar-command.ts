// Research Radar decision WritePlan (ADR-0032): append exactly one JSONL line under head-CAS/dedupe/trailers.
import { MAX_NOTE_BYTES, type ErrorCode, type Receipt, type ResearchRadarDecideCommand } from '@vault-companion/contracts';
import type { Planned, WritePlan } from './execute.ts';
import { canWrite, isRadarDecisionPath, parseVaultPath, RADAR_DECISIONS_DIR_LOCAL } from './paths.ts';
import {
  appendRadarDecisionLine,
  hasRadarDecisionId,
  RadarDecisionUnreadableError,
  radarPaperId,
  validateRadarDecisionMonths,
} from './research-radar-format.ts';
import { radarDecisionPath, readRadarDecisionHistory } from './research-radar.ts';
import { FileTooLarge, gitBlobSha } from './store.ts';

const refuse = (code: ErrorCode, message: string): Planned<never> => ({ ok: false, code, message });

type RadarCommand = ResearchRadarDecideCommand;

const decode = (bytes: Uint8Array): string | null => {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
};

export function researchRadarDecidePlan(cmd: RadarCommand, serverNow: Date): WritePlan<Receipt['effect']> {
  // The decision month is the server's Copenhagen month (review 7 finding 2): a backdated/offline client
  // timestamp never reopens an old monthly log. `line.at` remains the client's occurredAt.
  const path = parseVaultPath(radarDecisionPath(serverNow))!;
  const line = {
    schemaVersion: 1 as const,
    decisionId: cmd.operationId,
    paperId: cmd.payload.paperId,
    decision: cmd.payload.decision,
    undoes: cmd.payload.undoes,
    at: cmd.occurredAt,
    card: { title: cmd.payload.card.title, source: cmd.payload.card.source, topic: cmd.payload.card.topic },
  };
  const effect = { kind: 'research-radar-decided' as const, path, decisionId: cmd.operationId };
  return {
    message: 'Vault Companion: research radar decision',
    async compute(store, at) {
      if (!canWrite(path, 'create') || !canWrite(path, 'update')) return refuse('refused:path', 'Radar decision path is not writable');
      const id = await radarPaperId(cmd.payload.card.source);
      if (id !== cmd.payload.paperId) return refuse('invalid', 'paper identity does not match its source URL');
      try {
        const currentPath = radarDecisionPath(serverNow);
        const currentMonth = currentPath.slice(-13, -6);
        const files = await store.listFiles(RADAR_DECISIONS_DIR_LOCAL, at);
        const history = await readRadarDecisionHistory(store, at, files, currentMonth);
        const text = history.textByMonth.get(currentMonth) ?? null;
        if ([...history.textByMonth.values()].some((candidate) => candidate !== null && hasRadarDecisionId(candidate, cmd.operationId))) {
          return refuse('dedupe-unknown', 'decision ID already exists');
        }
        const currentLines = history.months.find((entry) => entry.month === currentMonth)?.lines ?? [];
        const months = [
          ...history.months.filter((entry) => entry.month !== currentMonth),
          { month: currentMonth, lines: [...currentLines, line] },
        ].sort((a, b) => a.month.localeCompare(b.month));
        try {
          validateRadarDecisionMonths(months);
        } catch (e) {
          if (e instanceof RadarDecisionUnreadableError) return refuse('invalid', e.message);
          throw e;
        }
        const bytes = appendRadarDecisionLine(text, line);
        if (bytes.length > MAX_NOTE_BYTES) return refuse('refused:too-large', 'Radar decision file would exceed 1 MB');
        return { ok: true, path, expect: text === null ? 'absent' : 'regular-file', bytes, effect };
      } catch (e) {
        if (e instanceof FileTooLarge) return refuse('refused:too-large', 'Radar decision file is larger than 1 MB');
        if (e instanceof RadarDecisionUnreadableError) {
          if (e.reason === 'encoding') return refuse('refused:encoding', e.message);
          if (e.reason === 'too-large') return refuse('refused:too-large', e.message);
          return refuse('invalid', e.message);
        }
        throw e;
      }
    },
    async deriveApplied(store, commitSha, changedPaths) {
      if (changedPaths.length !== 1) return { ok: false, reason: 'Radar decision commit does not change exactly one file' };
      const target = changedPaths[0]!;
      const targetPath = parseVaultPath(target);
      if (!targetPath || !isRadarDecisionPath(target)) return { ok: false, reason: 'Radar decision commit does not update a decision file' };
      const parent = await store.parentOf(commitSha);
      const [committed, before] = await Promise.all([
        store.readFile(targetPath, commitSha),
        store.readFile(targetPath, parent),
      ]);
      if (!committed) return { ok: false, reason: 'Radar decision file missing at the applied commit' };
      const beforeText = before === null ? null : decode(before.bytes);
      if (before !== null && beforeText === null) return { ok: false, reason: 'Radar decision file was not valid UTF-8 before the append' };
      if (await gitBlobSha(appendRadarDecisionLine(beforeText, line)) !== committed.blobSha) {
        return { ok: false, reason: 'Radar decision commit is not the expected append' };
      }
      return { ok: true, path: target, effect: { kind: 'research-radar-decided', path: target, decisionId: cmd.operationId } };
    },
  };
}
