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

## Milestone 3 — product improvement (Lead session `2c2489c5`, Herdr agent `lead`)

**Priority and product decisions:** the owner's vault note *Projects/Vault Companion/Vault Companion - Ready Backlog*
(read-only for the Lead, ADR-0018). This file tracks engineering status only.

**Order (owner, 2026-09-26):** B → C → S Part 2 → D. E dropped. F parked. AI capture triage parked until the owner
sets privacy rules.

| Increment | Brief | Engineering status |
|---|---|---|
| A handover visibility | — | done: PR #19, deployed |
| B task editing | ADR-0017 | **done:** PR #26 merged (d422b01), CodeRabbit real review (2 findings fixed); **deployed 467191a4**; owner phone test pending |
| C Active Work in the app | `docs/briefs/C-active-work.md`, ADR-0019 | **done:** PR #30 merged (9330478); CodeRabbit real review, 7 findings fixed (indented children refused, hidden-block openers refused, update banner, wording, tests); **deployed b5e69f1c**; owner phone test + 2-week review-date trial pending |
| S Part 2 scout status page | `docs/briefs/S2-scout-status-page.md`, ADR-0020 | **done:** PR #31 merged (2dbc3ed); CodeRabbit real review, 2 findings fixed (NFC output paths, ADR policy wording); **deployed cd0fc522**; owner phone test pending |
| D completion history | `docs/briefs/D-completion-history.md`, ADR-0021 | **done:** PR #32 merged (a0a616f; Claude Cloud worker + Lead symlink guard); CodeRabbit real review, 1 finding fixed; **deployed 73af3631**; owner phone test pending |
| N notes in the app (owner, 2026-09-27, from phone testing) | `docs/briefs/N-notes-worker.md`, ADR-0022 | **building:** contract on `agent/notes-base`; Claude Cloud session_01XhYEtucTSM6Ci592WuVuyk (pane w3:p1N) — owner must tell it "you may push" |

**Done in milestone 3 (all merged, CI green):** #18 write budget + review fixes · #19 A · #20 single-flight token ·
#21 ancestry without patches (ADR-0016) · #22 one read per app switch · #23 CSP smoke + zod jitless · #24
identity-safe duplicate-row fix · #25 e2e flakes. **Deployed: `73af3631` (D). **Owner order B → C → S Part 2 → D delivered (2026-09-27).** Next: owner picks from the Ready Backlog. #27 O3 real-stack e2e (Cloud) merged: 3 flows vs the real Worker app + LocalGitStore in Chromium; CodeRabbit real review, 1 finding fixed.**

**Capacity (2026-09-26 ~23:00):** Codex Astra ~4 % left, resets 02:29 · Antigravity quota out until ~2026-10-03 ·
Claude Cloud ~$10 credit; owner ran /web-setup (GitHub connected as Nextoz), so new Cloud sessions clone with push —
still probe a push at launch · CodeRabbit 1 review/hour · RAM 2–4 GB free: ≤ 1 Playwright job at a time.

**Open technical follow-ups:** R3 CPU re-measure after the latest deploys · O8
completion queued before midnight disappears · O4 harness through production composition · R7 blank line in Done ·
B follow-up: an edit applied but not yet receipted can briefly render twice · "New version — tap to reload" banner (owner
ran an old build after deploy) · post-save wording "reaches Obsidian at your next desktop sync" (desktop sync is hourly at
:06, vault task Sync-ObsidianVaultToGoogleDrive -RequireGitHubSync) — bundle both into C.

**Owner decisions pending:** G3 (count the day's owner-initiated writes as the canary?) · phone feedback on A and B.

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
