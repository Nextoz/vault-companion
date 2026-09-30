# Current plan

Lead: **Codex gpt-6-astra, temporary owner exception and Codex budget mode (2026-09-30)**, replacing Claude Opus while the Claude budget is low.
**Expires Thursday 2026-10-01 21:00 Europe/Copenhagen (19:00 UTC).** Finish the current safe step, checkpoint,
commit, and print `HANDOVER TO CLAUDE READY`; Claude Opus resumes the normal Lead role.
Routing, handoffs, resume: `docs/orchestration.md`. Checkpoint: `docs/checkpoint.md`.
**Latest (2026-09-30): continuous mode; select work from the live Ready table, top to bottom, plus batched bugs.**

## Temporary Lead operating constraints (owner, 2026-09-30)

**Owner update 3 below supersedes the older provisional, privacy and floor-routing limits in this file.**

- No Claude-plan workers or Claude Cloud. Claude-on-DeepSeek is allowed by update 3. **Codex budget mode expires
  Thursday 2026-10-01 21:00 Europe/Copenhagen (19:00 UTC).** Start no new OpenAI Codex workers;
  preserve H1's partial work after its quota exit. DeepSeek handles new implementation, including Pro floor work.
- Delegate implementation through `tools/agent-pane.sh` per the routing table; Lead plans, decomposes, integrates
  and accepts. Never wait or poll inside the Lead turn. For workers, CI, CodeRabbit or owner input, checkpoint and end with
  `WAITING: <what>`; a watcher pane sends `WAKE: <event>`.
- For Astra routing rows and H hook/gate code, open a PR with `hold`; do not merge. Independent Claude Lead review
  waits until the reset. Ordinary work follows normal PR/CodeRabbit/merge/deploy rules.
- Live vault remains read-only per ADR-0018; no hook enforces it yet. Never write outside `C:\Dev`.
- Build and test H's Claude hooks using piped-JSON fixtures; defer the live hooks-fire canary to the Claude Lead.

## Current execution (2026-09-30)

- 13:23: B3 Pro correction reviewed; B3/B4/SP1 batch independently FULL check **103files/1447tests** and
  single FULL browser suite **80/80** pass. Ordinary PR **#49** open, current-head CI/review pending; no H/RR
  floor changes included. One CodeRabbit request after final checkpoint push. RR1 correction now Pro **w5:pY**;
  H1 recovery/H2 correction active, three workers. Balance **$7.25**, reported spend$2.74. Phone/deploy unverified.
- 13:15: RR1 handoff/production diff reviewed; independent **85/85** tests + typecheck pass, targeted lint fails
  unused variable. Foreign-paper Undo and subsequent-decision replay bugs reproduced; Read ignores note target,
  mount targets wrong tab. RR1 unaccepted; one Pro correction queued in clone .agent/correction.md (not launched).
  Free slot used for priority H1 non-hook recovery **w5:pW**, original partial clone preserved; hooks untouched.
  H2/BUGS Pro corrections remain active; RR1 correction next free slot. Balance **$7.54**, reported spend$2.45;
  Jev RR1 redo .70/verification .08, Lead agrees from evidence. All floor review/deploy gates remain.
- 12:58: PR #48 merged `f4e7cc7`, CI green; #47 already merged. H2 handoff failed Lead contract review;
  one Pro correction active w5:pS. BUGS Flash correction handoff read; B4/SP1 changes look sound, B3 null
  history regression reproduced by Lead. Escalated to Pro w5:pT, same clone; unaccepted pending review/full
  check/e2e. RR1 Pro w5:pN remains active. H non-hook recovery next free slot, no new OpenAI Codex work.
  Balance **$8.47**, aggregate reported spend **$1.52**; stop new dispatch below $3. Jev H2 redo .74,
  BUGS redo .77; Lead agrees from concrete failures. One reasoning escalation, first picked SP1 redo1/first5.
  Latest resume instructions/evidence in checkpoint; consumed H2/BUGS handoffs excluded from watcher.
- 12:37 checkpoint: SP1 handoff/new files reviewed; independent synthetic benchmark **10/10** and typecheck pass.
  Production/phone latency still unmeasured. Test-discovery packaging and one inconsistent report comparison
  require focused correction; Lead defers mutable-head TTL recommendation, no cache implementation started.
- Reviewed B3/B4/SP1 candidates preserved locally: `c420882`, `38621cd`, `3ed9c47`. Cherry-picked into
  `C:/Dev/vault-companion-clones/b3-b4-fixes`, branch `agent/b3-b4-fixes`, base main `6080433`, candidate head
  `7050d3a`. Flash high correction worker **w5:pQ** active with disjoint files from H2/RR1; handoff
  `.agent/handoffs/BUGS.md`. It fixes B3/B4 edge cases and moves SP1 tests into normal apps/worker/test discovery
  without shared config edits. Full combined check/e2e remains required before the ordinary batch PR.
- Balance **$9.22** at 12:37; aggregate reported spend **$0.77**, concurrent per-run attribution unknown.
  Jev SP1 redo .83 / scope .82 / verification .30; Lead agrees limited packaging/report correction. First picked
  run has finished its initial attempt, accepted 0, correction required 1/first 5, reasoning escalations 0.
  Count this conservatively toward the routing kill switch; a second affected picked run disables active Jev routing.

- 12:28 checkpoint: B3 handoff/diff reviewed; independent targeted **19/19** plus typecheck pass. Fix before merge:
  unknown-count degraded run backed only by yesterday's success must not be dated at today's attempt; matching
  incomplete history must not suppress known current count. `.agent/B3-correction.md` queued for one Flash correction.
  Jev says redo .99; Lead agrees focused correction, no model escalation. Existing `noSuccess` naming cleanup deferred;
  state colors use shared styles, no new CSS change required. Neither bug is accepted/shipped yet.
- RR1 dispatched Pro high in `w5:pN`, clone `C:/Dev/vault-companion-clones/rr1-radar`, branch `agent/rr1-radar`,
  base `d542b4d`. Contract in clone `.agent/brief.md`: ranking/read model, component, new append-only decision log,
  exact retry/CAS/Undo regression oracles, ADR-0032. **Hold + independent Claude review**; mounting Scouts waits
  for B4 integration, no concurrent Scouts edits. RR2 desktop job not in scope. Latest balance **$9.54**, reported
  aggregate spend $0.45 since resume, concurrent attribution unknown. Active slots H2/SP1/RR1; bugs next.

- 12:20 checkpoint: PR #47 merged as `6080433`; update-3 follow-up PR **#48** open, Ubuntu/Windows CI green,
  CodeRabbit review requested once and pending. Local full check **1415 tests** and e2e **79/79** passed for #47.
- B4 handoff reviewed: independent component **7/7** and iPhone-WebKit Scouts browser **3/3** pass. Memoized
  Insights filtering accepted. Before bug-batch acceptance, fix Running counted as 'with problems' and unknown
  findings announced as 'no findings'; focused correction packet `.agent/B4-correction.md` queued, not launched.
  No escalation/redo; batch still unaccepted until correction, B3 integration and full combined verification.
- SP1 measurement dispatched on Flash high in `w5:pK`, clone `C:/Dev/vault-companion-clones/sp1-measure`,
  branch `agent/sp1-measure`, base `8a0ca36`; tool activity verified. Jev tier Flash .79, ordinary risk .68,
  ambiguity .28: pick followed (1 active picked run). Active slots: B3, H2, SP1. Next dispatch RR1, then remaining bugs.
- Latest balance **$9.71** at 12:20 Copenhagen (resume $9.99; aggregate reported spend $0.28;
  concurrent per-run attribution unknown). Jev B4 advice strong-review .56, verification .14; Lead retains
  unaccepted verdict pending focused correction/combined checks. No floor downgrade. Interim watcher rearmed
  for B3/H2/SP1 handoffs and PR #48 checks; B4's consumed handoff excluded to prevent repeated wake.

- Resume at 11:58 Copenhagen: clean documentation branch `bc5a853`; PR #47 CI green on Ubuntu/Windows,
  real CodeRabbit review completed and its stale-snapshot finding fixed. B3/B4 panes closed without tool activity,
  code changes or handoffs; restarted in the same clones on Flash with the original briefs plus failure context.
  H1 stopped at the Codex usage limit, leaving partial tracked and untracked harness work, no handoff. Preserve it;
  start no new Codex work. H non-hook implementation goes to Pro, then SP measurement, RR1, remaining bugs.
- Restart launch evidence: Windows workspace-write sandbox repeatedly failed with
  `orchestrator_helper_incomplete`; stopped those attempts. Unsandboxed Flash B3/B4 now execute tools in
  `w5:pE`/`w5:pF`. H2 launcher/profiles/watcher dispatched to Pro (`deepseek-v4-pro`) in `w5:pH`, clone
  `C:/Dev/vault-companion-clones/h2-launcher`, branch `agent/h2-launcher`, original base `bc5a853`.
  Pro tier alias `deepseek-pro` is not an API model ID; initial alias launch refused before implementation.
  These three tasks have disjoint allowed files. H2 handoff: `.agent/handoffs/H2.md`; held PR required.

- Pre-PR resume snapshot: clean `main` at `947570d`; the prior Herdr Lead was `w5:p1`, with no other agents or open
  PRs. Resume `pnpm check` passed: lint, typecheck, 101 files / 1415 tests. Refresh the resume SHA and PR state after
  PR #47 merges; historical worker/quota/queue statements below are superseded here.
- Ready Backlog re-read read-only: H first, then SP, RR, B3+B4. Never select work from the Ideas Backlog.
- H Part 1 is ready for engineering implementation; H1 core guards/gates stopped incomplete, H2 launch
  profiles/watcher now on DeepSeek Pro. H1 contract: `docs/briefs/H1-harness-core.md`.
  Acceptance: five required hook/gate eval fixtures plus failure cases, targeted checks, Lead full check/e2e;
  held PR and deferred independent review/canary mean H is not accepted or shipped yet.
- DeepSeek smoke passed; update 3 removes the formal B3 graduation gate.

## Owner update 3 — default DeepSeek backend (2026-09-30)

- DeepSeek is the default for **all implementation**, with no B3 graduation gate. Up to **3 DeepSeek workers**
  may run on independent files: Flash by default; Pro where Sol-medium would be chosen and for floor work.
- DeepSeek is trusted with **all vault data, including private content**. This supersedes the DeepSeek-only
  public/synthetic restriction; private text still never enters this repository, fixtures, logs or receipts.
  Live vault writes still require owner approval; Jev still receives public filtered packets only.
- No sandbox required. Default: Codex-on-DeepSeek with `--sandbox workspace-write`, isolated home/no MCP/memories;
  `Tools/claude-deepseek.ps1` is allowed if needed without WSL/container. This uses DeepSeek balance, not Codex quota.
- Floor work (auth, write path, persistence, concurrency, security, CI, harness) may go to Pro, with a **hold** PR,
  Lead diff review and later independent Claude review. Hook canary remains deferred; do not merge held work.
- Every diff gets Lead review; `verify-run` applies once available. Keep the **$3 stop**, **one Playwright job**,
  and **Codex budget mode until Thu 2026-10-01 21:00 Copenhagen**. No new OpenAI Codex workers.
- Balance at resume, 2026-09-30 11:58 Copenhagen: **$9.99**, API precision; reported change since smoke $0.00,
  sub-cent cost unknown. Record balance at every checkpoint. Weekday afternoon runs cost half.

## Owner update 2 — historical provisional rules and Jev (2026-09-30)

- Re-read current Harness Brief Parts 2 and 3. Smoke-test Codex 0.159.2 with a one-word DeepSeek response before
  dispatching real work. Verify provider/model/no MCP; measure balance before/after via the authorized balance API.
- After smoke PASS, DeepSeek is provisional: at most two DeepSeek workers plus one Codex worker, isolated clones,
  independent files, low-risk public/synthetic tasks only. Flash by default; Pro for ordinary Sol-medium scope.
  One Playwright job at a time. Below $3 balance, stop DeepSeek dispatch and emit `ACTION NEEDED:`.
- Until H is accepted, current checks/handoff plus Lead diff review apply; recheck the canary through H when available.
  Formal routing-table graduation waits for the B3 canary; no change to the permanent routing table yet.
- Jev Use 2 chooses low-risk workers only: obey tier when top probability >=0.60, integrity risk ordinary,
  and ambiguous probability <0.5. Otherwise Lead chooses and logs why. Always include unresolved as a choice.
- The deterministic floor takes precedence: auth/identity/account binding, writes/persistence/concurrency,
  security/privacy/new write targets, and CI/harness/hooks use the high-risk table. Log Jev advice but do not obey
  a lower pick. This includes H's non-hook harness code. Keep its files separate from low-risk product work.
- Every worker run gets Jev Use 1 (completion, verification, scope, silent failure, unsupported claims, disposition)
  recorded next to the Lead verdict. Only public filtered packets go to the authorized `Tools/jev.ps1` invocation.
  Responses live in gitignored `.agent/jev/`; receipts record agreement and rationale.
- If two of the first five Jev-picked runs need escalation/redo, disable active Jev routing, revert to shadow and
  tell the owner. At every checkpoint report followed/overruled picks, escalated runs, DeepSeek spend, and any
  proposed high-risk downgrade. Use unknown when evidence is missing; never invent a zero cost.
- Initial split: leave the running H1 guards/gates worker untouched. H2 launcher/watcher is floor work and is held
  while `CODEX LOW` is active. B3 insights and B4 compact Scouts are independent outside-floor work; re-run Jev
  with only DeepSeek Flash/Pro candidates and keep up to two DeepSeek workers busy. No private vault material is
  sent to workers or Jev.
- Accounting at 2026-09-30 06:59 Copenhagen: Jev picks followed **1 decision queued (B4, not run)**,
  overruled/fallback **1 (B3)**; completed Jev-picked implementation runs **0**; escalated runs **0**.
  DeepSeek balance before/after smoke **$9.99 → $9.99**, reported spend **$0.00** at API precision;
  sub-cent cost unknown. No implementation run on DeepSeek yet. No high-risk downgrade proposed.
- Smoke PASS: Codex 0.159.2, `deepseek-flash`, provider `deepseek`, effort high, no MCP startup, exact `ready` reply;
  5,211 transcript tokens. DeepSeek is now **provisional**, not formally added to routing. Jev Use 1 says close
  (probability .99); Lead agrees for this one-word smoke only (verification score .49 is retained in raw evidence).
- Historical pre-budget picks: B3 chose Codex Luna with top probability .41 and fell back to DeepSeek Flash;
  B4 chose Codex Luna .68. The owner's later budget-mode routing superseded both picks. A DeepSeek-only Jev re-ask
  failed with provider 403 (`no_providers_available`); no retry. In the saved earlier answers Flash ranked above Pro
  for both tasks, so the Lead used Flash as the explicit unavailable-Jev fallback.
- Jev responses and synthetic packets: `.agent/jev/{B3,B4}-routing.json`, `smoke-run.json`, and accompanying state/
  question files (gitignored through local `.git/info/exclude`). Clone briefs are `.agent/brief.md`.

## Delegated agents — resume 2026-09-30 afternoon Copenhagen

| Task | State / model | Herdr pane | Clone / branch / base |
|---|---|---|---|
| H1 core guards/gates | **STOPPED at quota, incomplete**, no handoff; partial work preserved; no new OpenAI Codex work | former `w5:p4` | `C:\Dev\vault-companion-clones\h1-harness`; `agent/h1-harness`, base `8ce1d57`; tracked and untracked edits |
| DeepSeek smoke | **Completed PASS**; deepseek-flash high; pane closed itself normally | former `w5:p5` | `C:\Dev\vault-companion-clones\deepseek-smoke`; inherited `docs/continuous-lead-20260930` at `5fc6a94`; no code edits |
| B3 degraded insights | **Handoff reviewed, focused correction queued**, targeted checks pass, unaccepted | former `w5:pE` | `C:\Dev\vault-companion-clones\b3-degraded`; `agent/b3-degraded` at `5fc6a94`; handoff `.agent/handoffs/B3.md`, log `.agent/unsandboxed.log` |
| B4 compact Scouts | **Handoff reviewed, correction queued**, targeted checks pass, not accepted | former `w5:pF` | `C:\Dev\vault-companion-clones\b4-compact`; `agent/b4-compact` at `5fc6a94`; handoff `.agent/handoffs/B4.md`, log `.agent/unsandboxed.log` |
| H2 non-hook launcher/profiles/watcher | **RUNNING**; DeepSeek Pro high (`deepseek-v4-pro`), unsandboxed tool activity verified | `w5:pH` | `C:/Dev/vault-companion-clones/h2-launcher`; `agent/h2-launcher`, base `bc5a853`; handoff `.agent/handoffs/H2.md`, log `.agent/pro.log`; hold PR |
| SP1 read-latency measurement | **Handoff reviewed**, independent tests pass; packaging/report correction in batch | former `w5:pK` | `C:/Dev/vault-companion-clones/sp1-measure`; candidate `3ed9c47`; handoff `.agent/handoffs/SP1.md` |
| RR1 Radar page/decisions | **RUNNING**, DeepSeek Pro high, hold required | `w5:pN` | `C:/Dev/vault-companion-clones/rr1-radar`; `agent/rr1-radar`, base `d542b4d`; handoff `.agent/handoffs/RR1.md` |
| B3/B4/SP1 focused corrections | **RUNNING**, Flash high, tool activity verified | `w5:pQ` | `C:/Dev/vault-companion-clones/b3-b4-fixes`; `agent/b3-b4-fixes`, candidate head `7050d3a`; handoff `.agent/handoffs/BUGS.md` |

- H1 log: `C:\Dev\vault-companion-clones\h1-harness\.agent\run.log`; session
  `01a0f0ab-4cde-7d12-9726-3ad8bd566a6a`. Expected report `.agent/handoffs/H1-harness-core.md`.
  Non-interactive workers do not appear in `herdr agent list`; pane + log are authoritative evidence of this run.
- B3/B4 first launch panes `w5:p7`/`w5:p8` exited before source work because the wrapper did not propagate the
  DeepSeek `CODEX_HOME`; retries inject it in the worker command. Do not count the failed starts as worker runs.
- Isolated homes under `C:\Dev\tools\vault-companion-codex-home` and `vault-companion-deepseek-home`; no MCP/memories.
  TEMP/TMP/TMPDIR `C:\Dev\tmp\vault-companion`; pnpm store `C:\Dev\tmp\pnpm-store`; npm cache `C:\Dev\tmp\npm-cache`.
  Never print/commit auth or keys. Existing DeepSeek config was copied to C:\Dev to honor the write boundary.
- Documentation PR **#47** at remote head `5fc6a94`: ubuntu/windows CI and CodeRabbit passed. CodeRabbit's one
  actionable stale-snapshot wording finding is fixed locally above; no repeat review request. Local branch also
  contains checkpoint `610699d` and the current owner-rule updates, not yet pushed at this line's timestamp.
- Owner requested this immediate checkpoint; all running workers are left untouched. No watcher was launched by
  this Lead yet. Other existing panes `w5:p2`/`w5:p3` are not this Lead's workers and were not altered.

## Waiting for Evgeny

- H risk floor: fill the deliberately owner-owned TODO in the forthcoming `docs/harness.md`; existing high-risk
  routing and the temporary hold rule apply meanwhile.
- H server-side required checks: review the forthcoming ADR proposal for protecting `main` while preserving
  checkpoint commits; only the owner changes the GitHub ruleset.
- Existing phone checks remain pending; no new phone feature has shipped in this session.
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
| N notes in the app | `docs/briefs/N-notes-worker.md`, ADR-0022 | **done:** PR #33 merged (6d000f6; Claude Cloud worker); security-review fix (InboxNotePath parser differential); CI caught a real 5-tab overflow at 390 px, fixed; CodeRabbit clean; **deployed 3feaf6b6** |
| T swipe triage for events, Part 2 | Ready Backlog T, ADR-0024 | **done:** PR #35 merged (5d9163e); CodeRabbit real review, 2 findings fixed (decisions serialized, never dropped; Never-row exceptions); **deployed 667e23c9**; owner phone test pending |
| C2 + S2a + C3 (owner bugs, 2026-09-27) | Ready Backlog C2, S2a, C3 | **done:** PR #36 merged (8a5ca2d); combined check 1240 tests + e2e 69/69; CodeRabbit 2 findings fixed (numeric calendar days, first-column label), stale C3 e2e assertion fixed; all mutation-checked; **deployed 0e34d79f**; owner phone test pending |
| L training log | Ready Backlog L, ADR-0025 | **done:** PR #39 merged (dd6e3e9); Codex Astra high; Astra adversarial review 1 High + 3 Medium + 1 Low fixed, CodeRabbit 3 fixed (stable row keys, ADR wording), all mutation-checked; flaky offline e2e fixed; check 1329 + e2e 73/73; **deployed ea770cc2**; owner phone test + unit-less row format confirmation pending |
| Scout insights v1 (deterministic) | Ideas Backlog "Scout insights across all scouts"; owner chose "build a first version" 2026-09-27 | **done:** PR #38 merged (37fca45); Codex Sol + Lead type fixes; CodeRabbit 4 findings fixed (per-card previews, failed reads retried, first-list fallback, exclusion test), mutation-checked; **deployed 5d52c100**; owner live test pending |
| README rewrite | owner request 2026-09-27 | **done:** PR #37 merged (Gemini 503 twice → Codex Terra; Lead verified claims; CodeRabbit 2 wording fixes) |
| L units, T2 triage, Progress Wall | Ready Backlog L/T, ADR-0025/0024 | **done:** PRs #40, #41, #42 merged + deployed (`d4403dcd`); owner phone test pending |
| Lease reclaim after reload | ADR-0028 | **done:** PR #43 merged (`7c5309e`), deployed `12692438` |
| R1 research explainer (cron + Gemini) | ADR-0029 + amendments 1, 2 | **done:** PR #45 merged (`ae5d438`); Gemini verified live; `GEMINI_API_KEY` set; crons `30 4`/`30 6` UTC registered (needed the account workers.dev subdomain; script workers.dev verified off via API); **first live run 2026-09-30 04:30 UTC — not yet observed** |
| B1 + B2 bugs, This morning (minimal) | Ready Backlog B1/B2; ADR-0029 Part 2 | **done:** PR #46 merged (`79129e4`), **deployed `df0a77a4`**; owner phone check after the first explainer run |
| B3 insights "Picks from Yesterday" | owner phone 2026-09-29 | **open** (checkpoint item 2a2) |
| SP app speed | Ready Backlog SP | **open:** measure first (planned for DeepSeek workers, 2026-09-30) |

**Workers running at checkpoint (2026-09-29 evening): none.** Only the Lead (Herdr `lead`, pane `w4:p1`). No Claude
Cloud sessions any more (owner: same usage pool, no credits).

**Done in milestone 3 (all merged, CI green):** #18 write budget + review fixes · #19 A · #20 single-flight token ·
#21 ancestry without patches (ADR-0016) · #22 one read per app switch · #23 CSP smoke + zod jitless · #24
identity-safe duplicate-row fix · #25 e2e flakes. **Deployed: `3feaf6b6` (N). **Owner order B → C → S Part 2 → D delivered (2026-09-27).** Next: owner picks from the Ready Backlog. #27 O3 real-stack e2e (Cloud) merged: 3 flows vs the real Worker app + LocalGitStore in Chromium; CodeRabbit real review, 1 finding fixed.**

**Capacity (2026-09-26 ~23:00):** Codex Astra ~4 % left, resets 02:29 · Antigravity quota out until ~2026-10-03 ·
Claude Cloud ~$10 credit; owner ran /web-setup (GitHub connected as Nextoz), so new Cloud sessions clone with push —
still probe a push at launch · CodeRabbit 1 review/hour · RAM 2–4 GB free: ≤ 1 Playwright job at a time.

**PR #34 merged + deployed `341041d1`** (R7, edit double row, O8 verified; CodeRabbit resolved both findings).

**Open technical follow-ups:** R3 CPU re-measure after the latest deploys · O4 harness through production composition ·
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
