# Brief: Phase 1 gate review (fresh context, adversarial)

Type: **review** (read-only). Assume the implementation is wrong somewhere and find where. You did not write it.
Two independent reviewers receive this brief (Claude Opus 5.5 and GPT-6 Astra); do not look for or read the other's report.

## Scope

Phase 1 code on `main` since `0cc7286` (`git diff 0cc7286..HEAD -- packages apps`):

- `packages/vault-markdown/**` — Markdown safety kernel (highest risk: byte-exact mutation).
- `packages/domain/src/{execute,commands,payload-hash,paths,time}.ts`, `testing/in-memory-store.ts` — retry/dedupe/CAS.
- `packages/github/src/{local-git-store,contents-store,app-token}.ts` — adapters (GitHub behaviour evidence:
  `docs/discovery/github-api-probe-2026-09-24.md`).
- `apps/worker/src/**` — auth, origin/CSRF, logging, production entry.
- `apps/web/src/queue/**`, `apps/web/src/api.ts`, `apps/web/src/commands.ts` — device pending queue.

Normative specs: `docs/vault-contract.md`, `docs/commands.md`, `docs/sync.md`, `docs/security.md`, ADRs in
`docs/decisions/`. Acceptance list: `docs/testing.md`. Worker reports: `docs/reviews/K-report.md`, `docs/reviews/F-report.md`.

## Must not

Edit any file except your report. No git commands that change state (no commit/checkout/stash). Do not open
`C:\Dev\vault-companion-vault-reference`. No network writes. Do not spawn agents. You may run `pnpm test`,
`pnpm typecheck`, `pnpm lint`, and write throwaway scripts **only under your OS temp dir**.

## Hunt for

1. **Data loss / corruption / duplication**: any input or interleaving where a durable effect is lost, applied twice,
   or applied to the wrong task/line; any byte outside the intended span that changes (EOL, BOM, final newline,
   blank lines, Unicode). Construct concrete inputs and, where possible, run them.
2. **Spec drift**: code that disagrees with vault-contract/commands/sync/security — cite both sides.
3. **Guards that can be bypassed**: path policy, origin/CSRF, auth, log allowlist, fail-closed config, account binding
   in the queue, conflict-marker refusal, recurring/on-completion refusal.
4. **Vacuous tests**: for the tests guarding the items above, name the production line whose breakage should fail
   the test; flag tests that would still pass against broken/old behaviour.
5. **Seams**: kernel ↔ domain (refusal codes, effects, decode/encode, BOM), domain ↔ HTTP (status/retryable), HTTP ↔
   queue (classification, retry of identical bytes), store ↔ executor (409 ref races, unknown outcomes).

## Output

Write your report to the file named in your launch prompt, with: findings table
`id | severity Critical/High/Medium/Low | file:line | problem | concrete failing input or interleaving | recommended fix`
(Critical = reachable durable loss/duplication/wrong-task write or auth bypass), then "Evidence run" (commands/scripts
you executed and results), then "What is sound", then verdict `PASS` / `PASS WITH FIXES` / `BLOCK`.
Reply in the terminal with **one line only**: `VERDICT: <verdict> — <n> findings (<c> critical, <h> high) — <report path>`.
