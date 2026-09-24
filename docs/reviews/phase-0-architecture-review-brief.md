# Brief: Phase 0 architecture review (fresh context, adversarial)

Type: **review** (read-only). You are an independent reviewer; assume the design may be wrong and search
for failure modes. You did not write it.

## Read

- `docs/product-contract.md`, `docs/vault-contract.md`, `docs/commands.md`, `docs/sync.md`,
  `docs/architecture.md`, `docs/security.md`, `docs/threat-model.md`, `docs/testing.md`,
  `docs/indexing.md`, `docs/decisions/*.md`, `docs/plan.md`
- Evidence: `docs/discovery/phase-0-findings.md`, `docs/discovery/git-sync-spike-output-2026-09-24.txt`,
  `tools/spikes/git-sync-spike.sh`
- Governing contract (long; read §2–3, §11 and §13 Phase 0–2 only):
  `docs/bootstrap/Vault_Companion_Claude_Opus55_Herdr_Bootstrap.md`

## Must not

Edit any file other than your report. Do not open `C:\Dev\vault-companion-vault-reference`
(the findings doc summarises it). Do not run git commands that change state. Do not spawn agents.

## Challenge specifically

1. Source-of-truth and sync wording — any claim the UI makes without evidence; any path where Drive or a
   cache becomes authoritative.
2. Retry/idempotency (`docs/commands.md`): construct concrete interleavings (lost response, double submit,
   CAS loss, unknown outcome, clock skew, base revision far behind, history rewritten by the desktop
   worker, two different ops racing on one file) and show whether any yields a duplicate or lost effect.
3. Task identity (ADR-0003 + vault-contract §3): cases where the locator resolves to the **wrong** task.
4. Completion/Undo/recurrence (vault-contract §4, ADR-0006): byte-level edge cases (EOL, no final newline,
   blank lines, child blocks, task already in Done, Done section empty, trailing whitespace, U+FE0F).
5. Security/privacy boundary: gaps versus bootstrap §3.8.
6. Scope creep versus bootstrap §2 first release — anything added that is not required, or required and missing.
7. Anything in the bootstrap's Phase 0 list not delivered.

## Output

Write `docs/reviews/phase-0-architecture-review.md` with: findings table
(`id | severity Critical/High/Medium/Low | doc+section | problem | concrete failing scenario | recommended fix`),
then "What is sound", then verdict `PASS` / `PASS WITH FIXES` / `BLOCK`.
Reply in the terminal with **one line only**: `VERDICT: <verdict> — <n> findings (<c> critical, <h> high) — docs/reviews/phase-0-architecture-review.md`.
