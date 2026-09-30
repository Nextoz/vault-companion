# Checkpoint — 2026-09-30 06:59 Europe/Copenhagen

Owner requested an immediate checkpoint. Running workers were left untouched. Follow CLAUDE.md / orchestration
resume procedure, then this file's exact next actions. Current Lead: Codex gpt-6-astra, temporary appointment and
expiry in docs/plan.md (2026-10-01 21:00 Copenhagen / 19:00 UTC). No Claude usage before handover.

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

## Running and prepared workers (do not redispatch)

| Task | State | Pane | Clone / branch |
|---|---|---|---|
| H1 | RUNNING, gpt-6-astra medium, real implementation activity, no final handoff yet | w5:p4 in Agents w5:t2 | C:/Dev/vault-companion-clones/h1-harness; agent/h1-harness, base 8ce1d57 |
| Smoke | Completed PASS; pane self-closed normally | former w5:p5 | C:/Dev/vault-companion-clones/deepseek-smoke; base 5fc6a94 |
| B3 | Prepared only; DeepSeek Flash selected by fallback | none | C:/Dev/vault-companion-clones/b3-degraded; agent/b3-degraded at 5fc6a94 |
| B4 | Prepared only; Jev selected Codex Luna medium, queued for Codex slot | none | C:/Dev/vault-companion-clones/b4-compact; agent/b4-compact at 5fc6a94 |

H1 log: C:/Dev/vault-companion-clones/h1-harness/.agent/run.log.
H1 session: 01a0f0ab-4cde-7d12-9726-3ad8bd566a6a. Handoff expected .agent/handoffs/H1-harness-core.md.
Non-interactive worker is absent from herdr agent list but present in pane inventory; do not mistake that for done.
Lead is w5:p1. Existing w5:p2 and w5:p3 were not created/altered by this Lead. No new watcher launched yet.

## Jev and spend accounting (required every checkpoint)

- Picks followed: 1 decision (B4), queued but not executed. Completed Jev-picked implementation runs: 0/first 5.
- Picks overruled/fallback: 1 (B3). Jev Luna top probability .41 < .60; ordinary .98, ambiguous .20.
  Lead chose authorized DeepSeek Flash canary. B4 Luna .68, ordinary 1.00, ambiguous .20 -> follow at medium.
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

1. Inspect H1 log/handoff before any new Codex dispatch. Wait inside the active turn for workers; background jobs
   do not wake Codex. One Codex worker maximum; Lead is the only Astra-high job. Do not stop the current worker.
2. Launch prepared B3 via tools/agent-pane.sh with DeepSeek home under C:/Dev and AGENT_USER_ENV=DEEPSEEK_API_KEY;
   record balance before/after and pane ID immediately. Smoke allows up to two DeepSeek plus one Codex, with disjoint
   files and low-risk only. B3 edits insights data/UI; B4 edits Scouts layout/CSS/tests. B4 waits for the Codex slot
   because its qualifying Jev pick was Luna. Don't override that pick just to fill a DeepSeek slot.
3. H1 completion: read diff/handoff, run Jev Use 1, disposition discoveries. One focused correction if needed;
   then escalation rule. Full Lead check and e2e before acceptance. Build H2 separately per high-risk floor.
   H hook/gate PR MUST have hold and await independent Claude review; live hook canary deferred to Claude.
4. PR #47 (https://github.com/Nextoz/vault-companion/pull/47): CI ubuntu/windows and CodeRabbit pending at checkpoint.
   Requested one full review already (issuecomment-5904387559). Read findings; no repeat request/rate-limit polling.
   Final checkpoint commit is local unless pushed after this checkpoint. Recheck hold/owner comments before merge.
5. Continue Ready order; park underspecified work under Waiting for Evgeny, print ACTION NEEDED and take next.
   H risk floor is deliberately owner TODO; main required-check rule remains an ADR proposal, no server mutation.
6. Before ending later for CI/CodeRabbit/owner, establish a watcher that sends WAKE to Lead; old wait-for-work.sh
   only prints/exits and does not wake Codex. End with WAITING. This immediate checkpoint supersedes waiting now.
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
