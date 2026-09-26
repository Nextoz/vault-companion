# Current plan

Lead: Claude Opus 5.5. Routing, handoffs, resume: `docs/orchestration.md`. Checkpoint: `docs/checkpoint.md`.
Updated 2026-09-26. **Goal now: the agreed first release (`docs/product-contract.md`) on the owner's phone.**
Ambition beyond that stays the owner's choice, informed by observed use (milestone 3).

## Verified done (merged on `main`, CI green on ubuntu + windows)

Kernel, stores, worker, auth, PWA shell + queue (Phase 1 gate) · CI (#3) · real-Git e2e harness, 19 scenarios (#4) ·
Today rule ADR-0012 (#5) · hermetic fixtures (#6) · offline service worker + `Vary` fix (#7) · linked notes, security
review PASS (#8) · client correctness: duplicate-task identity, read timeouts, conflict next steps, Undo in Done today,
Overdue below Today (#9) · account-aware drafts, one submitter per draft, ADR-0014 (#11) · 30 s test timeout (#12) ·
deploy scaffold: wrangler, `_headers`, secrets-only identifiers, `workers.dev` off, runbook `docs/deploy.md` (#10).

## Remaining blockers to the phone

| # | Blocker | Owner | Status |
|---|---|---|---|
| B1 | Token Undo, ADR-0013 | — | **merged** (#14; Astra BLOCK fixed, re-review PASS) |
| B2 | Active Work Now card | — | **merged** (#13) |
| B3 | Whole-system review of the combined build | Cloud Opus done; Astra high running | Opus **PASS WITH FIXES** (`docs/reviews/phase-2-review-opus.md`): O1 read budget + O5 Undo unknown-outcome + O6 stale escape → Cloud (P4-B session, `agent/read-budget`); O2 deploy sizing fixed in `docs/deploy.md` §0 |
| B4 | Desktop sync worker | Owner (applied) → Lead verified | **done**: patch installed 2026-09-26 02:56; first real run 03:06 `state: current`, local = remote `67c90fc`, nothing staged, 0 runtime files published. Cleanup-on-failure fix v2 (19/19; old cleanup fails the new case) ready for the owner to install |
| B5 | Cloudflare setup G2: GitHub App on vault repo, Access, secrets, first deploy | **Owner** (`docs/deploy.md` §1–§7) → Lead §8–§9 | ready to start |
| B6 | Canary G3: one approved phone → GitHub → desktop → Obsidian write | **Owner approval** | after B3, B4, B5 |

**Next demonstrable result:** the app installed on the iPhone, reading the live vault (after B5); then the canary (B6).

## Phone experience — verified vs. untested

Verified in tests (WebKit iPhone viewport + unit/e2e): Today/Overdue grouping, Active Work Now card,
complete + Undo (toast and Done today), task/note capture offline with exact-once send, draft recovery across reload
and two windows, conflict banner and next steps, linked note view with sanitised rendering, session/read errors.
**Untested until the installed iPhone app:** real network latency and the phone targets below, keyboard visibility,
long text, dictation, large text, VoiceOver, one-handed use, PWA install/update on iOS, real Access login.

| Phone target | Target |
|---|---|
| Open (warm, online) → task list | ≤ 1.5 s typical, ≤ 3 s worst |
| Tap Capture → keyboard ready | ≤ 0.5 s |
| Tap complete/save → local acknowledgement | ≤ 100 ms |
| Online → "saved to GitHub" | ≤ 5 s typical |
| Refused/conflicted action → clear, safe next step | ≤ 3 taps, no lost text; dismissing ≠ resolving |

Observations: none yet; recorded privately (`.private/`, git-ignored) during milestones 2–3.

## Owner decisions

T1 Today — decided, provisional (ADR-0012) · P1 Workers plan — **decided: Free** (owner, 2026-09-26). Real list 16 KB / 39 tasks ⇒ est. 4–5 ms CPU (10 ms cap);
read budget fixed by O1; measure real CPU with `wrangler tail` after the read-only deploy; optimise (O7: commits listing
instead of patch-carrying compare) only if a request nears the cap · D2 linked-note roots `Projects/`, `Tasks/`, `Inbox/` ·
D3 no `🆔` writes · D4 capture at top of Open (ADR-0010).

## Known limitations (accepted for the first release)

- Cold offline launch shows the shell and pending actions, not the task list (no vault content on device by design).
- Desktop conflicts surface only in the sync log/status file until the owner resolves them.
- Empty `## Open`: phone and desktop captures conflict (ADR-0010 residual). Undo of a completion whose line the desktop
  reopened and re-completed can reopen the later completion (text-equality residual, `docs/vault-contract.md`).
- Undo expires after 250 commits since the completion (`undo-expired`); an Undo whose completion receipt was lost
  cannot be sent (undo in Obsidian).
- R7 (Low): semantic Undo leaves a blank line in Done when Done has other content.

## Follow-ups (not blocking the first release)

Per-task conflict flags from the worker · single-page dedupe bound for other commands if budgets demand ·
shared lazy renderer loader · "Load latest draft" in a superseded window · lease reclaim after reload (60 s
"Saving…") · NFD/recursive-tree GitHub probes · A3 two-tab e2e flaked once under full parallel WebKit load.

## Human gates

G1 sandbox (done) · G2 credentials (B5) · G3 first live write (B6). Vault writes only with owner approval.
