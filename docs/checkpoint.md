# Checkpoint — 2026-09-30 12:28 Europe/Copenhagen

This section supersedes the historical 07:20 checkpoint below. Lead Codex budget mode expires Thu
2026-10-01 21:00 Copenhagen / 19:00 UTC; start no new OpenAI Codex workers.

## Completed and evidence (resume)

- Read repository contracts, plan/checkpoint/orchestration and the live Ready Backlog/Harness update 3,
  read-only. Queue H non-hook → SP measurement → RR1 → remaining bugs; never Ideas.
- PR #47 merged as `608043367b9b7c80500f132caa0e3e21c6f7a624` at 12:09 Copenhagen. Real CodeRabbit review's
  one stale-snapshot finding fixed; no hold/unanswered owner comment. Ubuntu/Windows CI green at `bc5a853`.
  Local full check PASS: 101 files/1415 tests; single e2e job PASS: 79/79.
- Update 3 committed in plan, routing table/operational entry and ADR-0030. DeepSeek default for all implementation,
  trusted with private data, three independent workers; Flash default, Pro for Sol-medium/floor. Pro API ID
  `deepseek-v4-pro`. Floor PRs retain hold, Lead review and later independent Claude review; live hook canary deferred.
- Default remains Codex-on-DeepSeek workspace-write. This resume found `orchestrator_helper_incomplete` before
  shell creation; stopped retries and used update-3-authorized unsandboxed launches successfully. No MCP/memories,
  key output, private repo/log text, vault writes or deployment. Claude-on-DeepSeek allowed if needed.
- Follow-up documentation PR **#48** open, Ubuntu/Windows CI passed; CodeRabbit requested once, pending.
  B4 handoff reviewed and independent component 7/7 + iPhone-WebKit Scouts 3/3 passed. Stable memoized Insights
  filtering accepted. Fix before batch merge: Running counted as 'with problems', unknown findings announced
  'no findings'. Packet `.agent/B4-correction.md` queued under remaining bugs, not a reasoning escalation.
- B3 handoff/diff reviewed; independent 19/19 focused tests + tsc -b passed. Missing timestamp/count edge
  cases need one Flash correction (.agent/B3-correction.md): old success must not date unknown degraded results
  at a new attempt; matching unknown historical count must not hide known current count. Unaccepted until fixed.
- RR1 Pro dispatched with bounded new-write-target contract/ADR and production golden CAS/dedupe/Undo oracles.
  Component implemented independently; Scouts mount after B4 correction/integration. No RR2 desktop job or
  new-target deployment authorized. Hold plus later independent Claude review required. SP1 remains active.

## Workers (resume) — handoff first, no duplicate dispatch

| Task | State / pane | Clone / evidence |
|---|---|---|
| H1 | STOPPED at Codex quota, former w5:p4 absent, no handoff | C:/Dev/vault-companion-clones/h1-harness; agent/h1-harness base 8ce1d57; partial tracked/untracked core preserved |
| B3 | HANDOFF reviewed; scoped checks pass; focused correction queued, unaccepted | C:/Dev/vault-companion-clones/b3-degraded; base 5fc6a94; .agent/unsandboxed.log; handoff .agent/handoffs/B3.md |
| B4 | HANDOFF reviewed, scoped checks pass, focused correction queued; unaccepted | C:/Dev/vault-companion-clones/b4-compact; base 5fc6a94; .agent/unsandboxed.log; handoff .agent/handoffs/B4.md |
| H2 | RUNNING Pro high, w5:pH; shell activity verified; hold required | C:/Dev/vault-companion-clones/h2-launcher; agent/h2-launcher base bc5a853; .agent/pro.log; handoff .agent/handoffs/H2.md |
| SP1 | RUNNING Flash high, w5:pK; shell activity verified | C:/Dev/vault-companion-clones/sp1-measure; agent/sp1-measure base 8a0ca36; .agent/run.log; handoff .agent/handoffs/SP1.md |
| RR1 | RUNNING Pro high, w5:pN; hold required | C:/Dev/vault-companion-clones/rr1-radar; agent/rr1-radar base d542b4d; .agent/run.log; handoff .agent/handoffs/RR1.md; .agent/RR1-scope-request.md for needed wiring outside envelope |

B3/B4 original panes pA/pB closed after opening prose, no code/handoff. Sandboxed retry panes pC/pD failed shell
creation and were interrupted. Same clones/briefs plus failure context. H2 alias `deepseek-pro` launch refused,
corrected to API ID. These are tooling restarts, not reasoning escalation. Three active tasks own disjoint files;
H2 may read partial H1 interfaces but may not edit that clone. No H1 acceptance or new OpenAI Codex work.

## Jev and balance (resume)

- DeepSeek 11:58 **$9.99** → 12:10 **$9.89** → 12:15 **$9.81** → 12:20 **$9.71**, reported aggregate change **$0.28**. Concurrent per-run attribution
  unknown; sub-cent cost unknown. Stop new dispatch below $3. Afternoon weekday runs cost half.
- Historical Jev picks followed 0 executed, overruled/fallback 2 (B3/B4 budget override), completed picked runs
  0/first 5, reasoning escalations 0. H2 Pro uses floor; no proposed downgrade.
- Jev is available again. Public failed-process check: unresolved probability .60, completed .07, verification .06,
  scope .40, silent failure .69, unsupported claims .42. Lead agrees stopped attempts incomplete/unaccepted;
  implementation correctness unknown. Raw .agent/jev/resume-failed-{state.md,run.json}. Individual completion
  checks still required. Jev remains public-only/advisory. Kill switch unchanged (2/first 5 need redo/escalation).
- SP1 Jev Flash .79, ordinary risk .68, ambiguous .28: pick followed, 1 active picked run; completed picked runs
  still 0. B4 Use 1 strong-review .56, verification .14; Lead agrees not accepted, independently ran focused tests
  and queued two precise wording fixes. H2 floor unchanged; no downgrade. Raw SP1-routing.json / B4-run.json.
- 12:28 balance **$9.54**; aggregate reported spend **$0.45**, per-run attribution unknown. B3 Jev redo .99,
  verification .15, scope .60; Lead agrees one precise correction, no reasoning escalation. B3/B4 were Lead
  fallback picks, not Jev-picked runs. SP1 remains first active picked run (0 completed); RR1 Pro floor, no downgrade.

## Exact next actions (resume)

1. On WAKE read named handoff, diff stat then full diff; disposition all discoveries. Run individual Jev Use 1,
   independently verify, record balance. Scope scan must include untracked files. Never accept prose alone.
2. Integrate B3/B4 as one bug-batch PR after Lead review, full check and one e2e; CodeRabbit per normal rules.
3. Review H2 non-hook work, then couple to H1 only once partial core is finished/reviewed. H1 is incomplete,
   preserve it; any later recovery routes Pro, never new OpenAI Codex. Keep H held for later independent Claude
   review/live hook canary. Risk-floor TODO owner-owned; GitHub required-check rule stays a proposal.
4. H2/SP1/RR1 now running; next free slot remaining bugs (B3/B4 focused corrections before batch acceptance). Re-read Ready before
   selection, Jev low-risk routing if available, max three independent workers, one Playwright job. SP1 measurements
   only; synthetic timings are not production/phone timings. H2 is current priority work.
5. Finish follow-up update-3 documentation PR, CI/review. #47 is already merged; no deployment needed for docs.
6. Interim .agent/watch-resume.ps1 rearm through visible wrapper; H2/SP1/RR1 handoffs, RR1 scope request and
   completed PR48 review+CI wake Lead w5:p2. Consumed B3/B4 handoffs excluded; no repeated CI-only wake.
   Do not wait/poll inside Lead turn. H2 implements durable watcher signals. At expiry checkpoint/commit and
   print HANDOVER TO CLAUDE READY.

Production unchanged: last deploy PR #46, 79129e4 / df0a77a4; no first-explainer observation this turn.
Phone checks, CPU measurement and triage unreadable-lines diagnosis remain open. No new shipped claim.

---

# Historical checkpoint — 2026-09-30 07:20 Europe/Copenhagen

Follow CLAUDE.md / orchestration resume procedure, then this file's exact next actions. Current Lead: Codex
gpt-6-astra in `CODEX LOW` budget mode; temporary appointment and budget mode expire 2026-10-01 21:00 Copenhagen
/ 19:00 UTC. No Claude usage before handover. Start no new Codex worker while `CODEX LOW` is active.

## Completed and evidence

- Read AGENTS.md, CLAUDE.md, orchestration and prior checkpoint/plan. Reconciled clean main at 947570d.
- Resume `pnpm check` PASS: lint, typecheck, 101 files / 1415 tests. No e2e run this session yet.
- Read Ready Backlog and Harness Brief in authorized live-vault scope, read-only. Queue: H, SP, RR, B3+B4.
  Never use Ideas Backlog as a build queue. Re-read updated Harness Parts 2/3 after owner update 2.
- Recorded durable continuous rules in orchestration; temporary appointment/constraints and owner update 2 in plan.
  Committed 8ce1d57 and 5fc6a94; documentation PR #47 open. No application change merged/deployed.
- H1 bounded acceptance packet: docs/briefs/H1-harness-core.md. H2 launcher/profiles/watcher remains to brief.
- DeepSeek one-word smoke PASS: Codex 0.159.2, model deepseek-flash, provider deepseek, effort high, no MCP startup,
  exact ready response, 5211 transcript tokens. DeepSeek is provisional under owner update 2.
- Prepared independent B3 and B4 briefs/clones; dependency installs succeeded. Neither worker launched yet.
- Isolated Codex/DeepSeek homes and caches under C:/Dev; never write outside C:/Dev. Vault remains read-only.
- Recorded the owner's Codex budget mode in plan and the no-wait/no-poll, handoff-only, 20-log-line, diff-stat and
  Jev-answer-only token rules in orchestration. Outside-floor work routes to DeepSeek; floor work is one Astra
  medium worker maximum, with Astra-high held for the Claude Lead after reset.
- PR #47 remote head 5fc6a94: ubuntu/windows CI and CodeRabbit passed. CodeRabbit's single stale-snapshot wording
  finding is fixed locally; do not request a repeat review. Local checkpoint 610699d plus this update still need push.

## Running and prepared workers (do not redispatch)

| Task | State | Pane | Clone / branch |
|---|---|---|---|
| H1 | RUNNING, gpt-6-astra medium, real implementation activity, no final handoff yet | w5:p4 in Agents w5:t2 | C:/Dev/vault-companion-clones/h1-harness; agent/h1-harness, base 8ce1d57 |
| Smoke | Completed PASS; pane self-closed normally | former w5:p5 | C:/Dev/vault-companion-clones/deepseek-smoke; base 5fc6a94 |
| B3 | RUNNING; DeepSeek Flash high, real activity verified | w5:pA | C:/Dev/vault-companion-clones/b3-degraded; agent/b3-degraded at 5fc6a94 |
| B4 | RUNNING; DeepSeek Flash high, real activity verified | w5:pB | C:/Dev/vault-companion-clones/b4-compact; agent/b4-compact at 5fc6a94 |

H1 log: C:/Dev/vault-companion-clones/h1-harness/.agent/run.log.
H1 session: 01a0f0ab-4cde-7d12-9726-3ad8bd566a6a. Handoff expected .agent/handoffs/H1-harness-core.md.
Non-interactive workers are absent from herdr agent list but present in pane inventory; do not mistake that for
done. B3/B4 initial panes w5:p7/w5:p8 exited before source work because `CODEX_HOME` was not propagated; retries
inject it in the worker command and are the runs above. Lead is w5:p2. Do not wait or poll; watcher wake is expected.

## Jev and spend accounting (required every checkpoint)

- Historical picks followed: 0 executed. Completed Jev-picked implementation runs: 0/first 5.
- Historical picks overruled/fallback: 2 (B3 and B4) because the owner's later DeepSeek-only budget routing
  superseded Codex choices. A new DeepSeek-only Jev call failed once with provider 403/no provider; no retry.
  Earlier saved answer fields ranked Flash above Pro for both, so the Lead selected Flash as unavailable-Jev fallback.
- Escalated runs: 0. High-risk downgrade suggestions: none. H1 uses deterministic high-risk floor, not Jev routing.
- Smoke Jev run check: close probability .99, completed .80, verification .49, scope .84, silent failure .20,
  unsupported claims .38. Lead accepts only the observed one-word smoke, no implementation claim.
- DeepSeek API before/after: $9.99 -> $9.99. Reported spend so far $0.00 at API precision; sub-cent cost unknown.
  Balance snapshots: C:/Dev/tmp/vault-companion/deepseek-balance-{before,after-smoke}.json.
- Raw Jev responses/state/questions: .agent/jev (gitignored locally). Synthetic B3/B4 packets: .agent/B3-brief.md,
  .agent/B4-brief.md and each prepared clone's .agent/brief.md. Preserve these local files across resume.
- Stop dispatch below $3; active routing kill switch after 2 of first 5 Jev-picked runs require escalation/redo.
  Every finished worker still needs Jev Use 1 and the Lead's evidence verdict.

## Exact next actions

1. On `WAKE`, read the named worker handoff, not its log. Use `git diff --stat`; do not read source directly.
   H1 stays untouched until its handoff exists. Start no new Codex worker while `CODEX LOW` remains active.
2. B3/B4 are running in disjoint clones. On each handoff, run Jev Use 1 if Jev is available; otherwise record the
   provider blocker once and perform the Lead evidence verdict. Record DeepSeek balance after both finish.
3. H1 completion: read diff/handoff, run Jev Use 1, disposition discoveries. One focused correction if needed;
   then escalation rule. Full Lead check and e2e before acceptance. Build H2 separately per high-risk floor.
   H hook/gate PR MUST have hold and await independent Claude review; live hook canary deferred to Claude.
4. PR #47 (https://github.com/Nextoz/vault-companion/pull/47): push checkpoint 610699d plus the current owner-rule
   update. CI and CodeRabbit passed at old head; do not repeat-request CodeRabbit. Recheck hold/owner comments before merge.
5. Continue Ready order; park underspecified work under Waiting for Evgeny, print ACTION NEEDED and take next.
   H risk floor is deliberately owner TODO; main required-check rule remains an ADR proposal, no server mutation.
6. Never wait or poll inside the Lead turn. End with `WAITING: H1/B3/B4 handoff`; the watcher sends `WAKE:`.
7. At 2026-10-01 21:00 Copenhagen finish a safe step, checkpoint/commit, print HANDOVER TO CLAUDE READY.

## Production and open evidence preserved

- Last verified deployment is PR #46 (79129e4), Worker df0a77a4 at app.karpov.dk, anonymous 302.
  Crons 30 4 / 30 6 UTC; script workers.dev and previews disabled; GEMINI_API_KEY already set.
- First 2026-09-30 explainer run not observed in this session. Read allowed Research/Explained and scout status
  paths only; no private text in repo/logs. CPU via approved observability remains to measure.
- Phone checks pending: This morning, B1/B2, training/Progress/triage/Scout insights. No new SHIPPED claim.
- Triage-applier unreadable decision lines diagnosis remains read-only. SP measurement, RR, code tour/learning
  guide, AGENTS rule-4 head-CAS wording and G3 remain as prior follow-ups; queue governs which starts next.
- Ask owner before deploying auth, identity, write-path or new-write-target changes. Never merge hold or unanswered
  owner comment. No Claude Cloud. Normal runbook remains docs/deploy.md plus previous checkpoint API observation:
  dashboard Domains & Routes guidance is stale. Do not deploy from a dirty build.
