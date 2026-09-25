# Current plan

Lead: Claude Opus 5.5 (Herdr pane `w3:p1`). Orchestration, routing, handoffs, resume protocol: `docs/orchestration.md`.
Checkpoint: `docs/checkpoint.md`. Updated: 2026-09-25 (after the independent product review of `e0979a0`).

**Ambition (owner):** the app the owner naturally opens on the phone to see what matters, act, capture and retrieve
vault context. The narrow first release (`docs/product-contract.md`) and the Markdown/Git architecture stay; later
priorities are the owner's choice, informed by observed use (milestone 3).

## Done

- Phase 0 discovery, ADR-0001…0011. Phase 1 kernel/stores/worker/PWA/queue — gate passed with fixes (run 3,
  `docs/reviews/phase-1-reconciliation.md`). Spec drift (PR #1), public scrub (PR #2), CI on every PR (PR #3:
  ubuntu + windows, WebKit e2e, audit, gitleaks).
- Desktop sync worker (live, read-only inspection 2026-09-25): commits local edits before fetch, merges compatible
  divergence via `merge-tree`, never force-pushes, on overlap preserves both commits **without** conflict markers and
  records `conflict` in `.git/vault-sync-status.json` ⇒ W1–W4 met by design. Surfacing to the owner is log/status only.

## Milestone 1 — Integrated first-release build (current)

Exit: all streams below merged, `pnpm check` + e2e + CI green, known limitations listed here, **and** the whole-system
review passed against the **combined merged build** (P2-A, P2-B, P3-A, P4-A/B/C/D and T1 together — their UI and
storage changes overlap, so no stream is reviewed only in isolation).

| Stream | Worker | Status |
|---|---|---|
| P2-A real-Git e2e harness (PR #4) | Cloud `session_01FyLWeGWnPruL9dXefaVGf3` | fixing Astra review (`docs/reviews/P2A-review-astra.md`: forced CAS collision, same-anchor conflict, desktop push race, cleanup) |
| P2-B service-worker offline shell e2e | Cloud `session_01LWfCSsJj1eCeWtXgpcYspN`, `agent/offline-shell-e2e` | in flight |
| P3-A Cloudflare deploy scaffold + `docs/deploy.md` | Cloud `session_01BtqCxHaRkAXZ53YDZ4QSe4`, `agent/deploy-scaffold` | in flight; Lead dispositions sent (minimal `allowBuilds`, identifying values as secrets, `_headers` + drift test) |
| P4-A linked note context (contract item 7) | Cloud `session_012WDdnkDZjTWRF4956Mjaoz`, `agent/linked-notes` | in flight; Astra adversarial review before merge |
| P4-B client correctness: duplicate-task identity, read timeouts/error state, conflict next step, Undo in Done today | Cloud `session_01TLT6gLxkoKtDHSy8CcCpmb`, `agent/client-correctness` | in flight |
| P4-C capture draft recovery (account-aware, separate from the queue) | Cloud `session_01H7tmZxTqo9BDE7UHb5esX1`, `agent/draft-recovery` | in flight |
| T1 Today rule (domain read model) | Codex Astra low, clone `…-clones/today-rule` | in flight |
| T1 Today layout (Overdue below, collapsed) | P4-B addendum | in flight |
| P4-D Active Work Now read-only card | Cloud, after P4-A merges (reuses its renderer) | queued |
| Whole-system review (Phase 2 gate + milestone 1 exit) | Cloud Opus + Astra, `docs/reviews/phase-2-review-brief.md` | after **all** milestone-1 streams merge |

Every branch: PR → CodeRabbit loop → CI → handoff dispositions (`.agent/handoffs/`) → merge.

## Milestone 2 — Authorized phone-to-vault canary

Owner decision 2026-09-25: deploy against the **live vault** (no sandbox deploy), first write canary-gated.
1. Owner G2 with `docs/deploy.md`: Cloudflare Access app + policy; GitHub App (Contents read/write) installed only on
   the vault repo; `wrangler secret put`. Lead deploys, verifies reads against the live vault (read-only).
2. Install the PWA on the iPhone; phone acceptance pass (below).
3. **G3**: owner approves one exact write (target file, expected diff, pre-canary SHAs, Drive backup time, rollback
   `git revert`). Evidence: GitHub commit with trailers, desktop worker log showing arrival, Obsidian renders it.

## Milestone 3 — Several days of owner use

Owner uses it daily; friction is recorded privately (`.private/observations.md`, git-ignored — never in the public
repo), then the owner chooses the next improvement from observed use.

### Phone targets (targets, not observations)

| Moment | Target |
|---|---|
| Open app (warm, online) → task list visible | ≤ 1.5 s typical, ≤ 3 s worst |
| Open app offline (cold) → shell + pending actions visible | ≤ 1.5 s; task list **not** available offline (by design) |
| Tap Capture → keyboard ready | ≤ 0.5 s |
| Tap complete/save → local acknowledgement (state chip) | ≤ 100 ms |
| Online → "saved to GitHub" | ≤ 5 s typical |
| Refused/conflicted action → clear, safe next step | ≤ 3 taps, no lost text; dismissing is **not** resolving the conflict |

Observations: none yet (recorded privately in milestone 2–3).

## Owner decisions

| # | Decision | Status |
|---|---|---|
| T1 | Today meaning | **decided** (provisional) — ADR-0012 |
| D2 | Linked-note allowlist | default `Projects/`, `Tasks/`, `Inbox/` (P4-A implements it) |
| D3 | Task IDs | no `🆔` writes in first release |
| D4 | Capture anchor | decided: top of Open (ADR-0010) |

## Known limitations and risks (current only)

- Cold offline launch shows the shell and pending actions, not the task list (reads are `no-store`, no vault content
  on device by design). Stated in the UI copy by P4-B/P2-B.
- Desktop conflicts are surfaced only in the sync log/status file; the app cannot see them until the owner resolves.
- R7 residue (Low): semantic Undo leaves a blank line in Done when Done has other content (needs vault-contract §4.2).
- Workers subrequest budget for Undo dedupe paging × 5 attempts — P3-A sizing note decides the plan.
- Phone accessibility (keyboard visibility, long text, dictation, large text, focus, VoiceOver, one-handed) is
  verified only on the installed iPhone app in milestone 2.

## Human gates

G1 sandbox (done) · G2 credentials (milestone 2) · G3 first live write (milestone 2).
