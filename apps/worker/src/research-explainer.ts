// The daily research-explainer job (ADR-0029): Cron Trigger → one run → at most one commit. Logs carry only the
// allowlisted record (no paper, model or note text; no key).
import { runResearchExplainer, slotForCron, type PaperExplainer, type VaultStore } from '@vault-companion/domain';
import { diagnosticDetail, sanitize, type LogSink } from './log.ts';

export const EXPLAINER_ROUTE = 'cron:research-explainer';

export interface ExplainerJobDeps {
  readonly store: VaultStore;
  readonly explainer: PaperExplainer;
  readonly now: () => Date;
  readonly timeZone: string;
  readonly subrequests: () => number;
  readonly log: LogSink;
  /** Override of SUBREQUEST_BUDGET (tests). */
  readonly budget?: number;
}

export async function runExplainerJob(cron: string, deps: ExplainerJobDeps): Promise<void> {
  const started = Date.now();
  const base = { requestId: crypto.randomUUID(), method: 'CRON', route: EXPLAINER_ROUTE, commandType: 'research-explainer' };
  const slot = slotForCron(cron);
  if (!slot) {
    deps.log(sanitize({ ...base, status: 400, durationMs: 0, errorCode: 'unknown-cron' }));
    return;
  }
  try {
    const r = await runResearchExplainer(deps, slot);
    const durationMs = Date.now() - started;
    if (r.kind === 'committed') deps.log(sanitize({ ...base, status: 200, durationMs, operationId: r.operationId, commitSha: r.commitSha }));
    else deps.log(sanitize({ ...base, status: r.kind === 'not-written' ? 503 : 204, durationMs, errorCode: r.kind === 'not-written' ? `not-written:${r.reason}` : r.kind }));
  } catch (err) {
    const detail = diagnosticDetail(err);
    deps.log(sanitize({
      ...base, status: 500, durationMs: Date.now() - started, errorCode: 'internal',
      errorClass: err instanceof Error ? err.name : 'unknown', ...(detail ? { errorDetail: detail } : {}),
    }));
  }
}
