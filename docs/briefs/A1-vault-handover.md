# Brief A1 — vault handover visibility (Astra, effort medium)

Read `AGENTS.md` first. Work in this clone on branch `agent/vault-handover` (already = PR #18 branch + main).
You cannot commit: leave changes in the working tree; the Lead commits. Do not edit `docs/plan.md`.

## Goal (owner story)
The owner plans with AI on the desktop; the desktop sync pushes the vault to GitHub; then they open the phone app.
They must be able to see, at a glance, **which vault state the phone is showing and whether it is fresh**, and
refresh on demand. Nothing about reads/writes changes semantically; this is read-model + UI only.

## Server
1. `VaultStore` (`packages/domain/src/store.ts`): add `commitMeta(commitSha): Promise<{ committedAt: string; fromApp: boolean } | null>`.
   - `GitHubContentsStore`: one `GET /git/commits/{sha}` (no patches). `committedAt` = committer date (ISO);
     `fromApp` = message contains a `Vault-Companion-Op:` trailer (reuse the existing trailer constant/parser).
   - `LocalGitStore` and every test fake/store-contract test: implement it.
   - The commit **message text must never leave the adapter** (privacy rule 6): only the two fields.
2. `TasksResponse` (`packages/contracts`): add `vault: z.strictObject({ committedAt: z.iso.datetime({ offset: true }), fromApp: z.boolean() }).nullable()`.
   The tasks read (domain) fills it for the revision it read. If `commitMeta` throws or returns null ⇒ `vault: null`;
   the task read must still succeed (test this).
3. Update `packages/github/src/read-budget.test.ts` for exactly +1 GitHub call per task read; keep all existing bounds.

## Client (`apps/web`)
4. Build info: `vite.config.ts` `define` `__APP_BUILD__ = { commit: <git rev-parse --short HEAD or 'dev'>, builtAt: ISO }`
   (declare the type; tests/vitest must not break when git is unavailable).
5. A compact **vault status line** directly under the app header (reuse existing styles/tokens, `StateChip` idioms):
   - `Vault updated 14:07 · from desktop` (or `· from this app`; show `Sat 26 Sep 14:07` when not today in the
     read's `timeZone`); `vault: null` ⇒ `Vault revision 2915455`.
   - `Checked 14:10` = client time of the last **successful** task read.
   - If the last read attempt failed, or the last success is older than 10 minutes, say
     `Not refreshed since 14:10` in the existing warning style (no new colours).
   - A **Refresh** button (≥ 44 px tap target, accessible name "Refresh vault") that calls the existing
     `refreshTasks`; disabled with `aria-busy` while a read is in flight. Do not add new auto-refresh triggers.
   - Tapping the line reveals details: full-ish vault SHA (12 chars) and `App <commit> · built <date time>`.
6. Keep logic out of JSX where practical: put formatting/freshness rules in a pure module (e.g. `src/freshness.ts`)
   with unit tests (today vs other day, zone, null vault, failed read, 10-minute boundary).

## Tests (each must fail if its guard is broken — AGENTS.md rule 7)
- contracts schema test; domain read test incl. `vault: null` on meta failure; GitHub adapter recorded-shape test
  (trailer ⇒ fromApp true, none ⇒ false, message text absent from the result); LocalGitStore via store-contract.
- Playwright (`apps/web/e2e`, mock API): status line renders; Refresh triggers one new `/api/tasks` read and updates
  `Checked`; failed read ⇒ "Not refreshed since". Update `mock-api.ts` responses with `vault`.
- `pnpm check` green. Run the web e2e for the new spec and the full web e2e once.

## Handoff
Write `.agent/handoffs/A1-vault-handover.md` (Completed / Important discoveries / Recommend / Verification with the
commands you ran and results). Concise. Synthetic data only.
