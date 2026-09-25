# Handoff P2-A — Phase 2 disposable e2e harness

Branch `agent/e2e-harness` (PR #4). Full report: `docs/briefs/P2A-report.md`.

## Completed

- `packages/e2e`: real `createApp` + real Access verifier (local JWKS) + command service over `LocalGitStore` on a temp
  bare repo, hosted on Node; desktop clone with a W1–W5 `sync()` model; phone client using the Zod contracts.
- 19 scenarios, each asserting exact desktop bytes: all brief scenarios, plus the 4 Astra review fixes (gated head-CAS
  collision, same-anchor conflict with empty Open, desktop push race, cleanup on setup failure).
- No production code changed.

## Important discoveries

- Cloud session started with no `origin` remote; the push only worked after the repo was attached to the session.
  Cloud briefs should launch with the repo as source (already noted on main in `80f2ca6`).
- During a committed-markers conflict, `GET /api/tasks` sets `writeBlock` but still lists lines inside the markers as
  open, and the completed copy in `doneToday`. The UI must lead with the conflict banner.
- Empty `## Open` makes ADR-0010 top-insert and QuickAdd append coincide ⇒ concurrent captures conflict (expected
  residual). After markers are committed, all app writes stop until the owner resolves them.
- `LocalGitStore` takes its git environment only from `process.env` at construction (harness scopes it).
- `packages/github` git-fixture tests are not hermetic (global git config leaks in: `push negotiation failed` warnings).
- The store cannot run in a child Node process under type-stripping (`contents-store.ts` parameter properties), so the
  push-race competitor is a second git clone, not the app.
- Brief listed `node >=24`; the container has Node 22.22.2 and everything passed.

## Recommend

- Fix now: nothing blocking; merge PR #4.
- Follow-up: web app check that `writeBlock: refused:vault-conflict` hides/qualifies task views; optional `env` option on
  `LocalGitStore`; make `packages/github` git fixtures hermetic (`GIT_CONFIG_GLOBAL`/`GIT_CONFIG_NOSYSTEM`).
- Canary gate: decide the real worker's W4 representation (markers vs conflict copy vs blocked) — the model uses markers.
- Leave alone: relative import of `apps/worker/src/app.ts` (worker only exports its Workers entry).

## Verification

- `pnpm check` (lint + typecheck + test): exit 0, 28 files, 462 tests (19 in `packages/e2e`).
- e2e suite 3 consecutive green runs.
- Mutation checks, each restored after: no head-CAS in `update-ref` ⇒ 3 tests fail on 3/3 runs; no dedupe hit ⇒ 2 fail;
  single push attempt ⇒ push race fails; W4 discarding a side ⇒ both conflict tests fail; late cleanup registration ⇒
  setup-failure test fails.

## Commit

- `73cb200` harness; `38144f6` review fixes; this handoff is the next commit on `agent/e2e-harness`.
