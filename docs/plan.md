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

## Milestone 3 — product improvement (started 2026-09-26, Lead session `2c2489c5`, Herdr agent `lead`)

Owner's first-use feedback reconciled with the vault Ideas Backlog (private; candidates recorded there). Owner chose
**A handover visibility** first; E (AI condensation of Active Work) marked interesting; AI capture triage parked in
the backlog. Remaining candidates (owner ranks later): B task editing, C curated Active Work, D completion history,
E, F preview-before-production.

| Work | Result |
|---|---|
| PR #18 (ADR-0015 + review P18-1/P18-2 fixes) | merged 57aeaa6; Astra high review; CodeRabbit: 1 finding rejected with reason, fix commit rate-limited |
| A1 vault handover visibility, PR #19 | merged 1292f48; **deployed version 79ac4949** (app.karpov.dk); CodeRabbit rate-limited (not a pass) |

Merged + **deployed version 0d20189f** (2026-09-26): #20 O10 single-flight token · #21 O7 ancestry without patches
(ADR-0016) · #22 one read per app switch. CodeRabbit rate-limited on all three (recorded; not a pass).
Held, not merged: dup-row (Antigravity; clone dup-row) removes an identity guard — redo with Astra high after 21:26:
attach a live Undo to an open row only when the completed line is absent from the read; keep its test as the spec.
PR #23 O11 CSP smoke + zod jitless (Antigravity; Lead-verified, CI green) — merge after CodeRabbit (pending) or its rate-limit reply.
Running: agy-gemini-pro · e2e-flakes (w3:p19, tests/config only) · Claude Cloud O3 session_015TkdrdhYa8Z9fuRvTTLqhX (no
branch after 25 min — ask it: claude -p "status? push your branch" --cloud <id>, when RAM allows).
2026-09-26 ~17:50: RAM 1.3/15.4 GB free; Claude Code reaped the Lead's background watchers. Keep ≤ 1 heavy local job
(Playwright) at a time.
**Codex limit resets 21:26** (owner): session cron at 21:28 resumes Codex work (dup-row high, then next backlog).
Token economy: AGENTS.md worker rules + docs/orchestration.md.

Next: owner tests A on the phone (first resume may need one app reopen: the old client predates the forward-compat strip), collect feedback; then owner ranks B/C/D/E/F. Follow-up: transient duplicate Today row on read/receipt ordering (Antigravity task prepared in clone dup-row, launch blocked pending permission rule match). R3 CPU re-measure from the live log.

## Status (2026-09-26): the app is live on the owner's phone

Deployed `main` `36aeb42` to `https://app.karpov.dk` (Workers Free, Access owner-only). Reads and live writes verified
end to end (phone → GitHub → desktop); details and evidence: `docs/checkpoint.md`.

| # | Remaining | Owner | Status |
|---|---|---|---|
| R1 | PR #18: every write within Free (ADR-0015) + A4 + F1–F3 | next Lead | open, unreviewed |
| R2 | G3: count today's owner-initiated writes as the canary, or run a formal one | Owner | decision |
| R3 | Write CPU up to 15 ms vs 10 ms Free cap | next Lead | re-measure after R1; optimise (O7) if needed |
| R4 | Review follow-ups O3/O4/O7/O9–O11 | next Lead | not blocking daily use |

**Next demonstrable result:** milestone 3 — several days of owner use, improvements chosen from observed friction.

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
