# Checkpoint — 2026-10-02 02:55 (UI refresh slice 1 merged, not deployed)

Overwrite this file at milestones only. ≤ 40 lines. Policy lives in `docs/orchestration.md`, not here.

## State

- **Merged, NOT deployed: UI refresh slice 1 #67** (main `7f49072`): permanent dark iOS tokens + Today pilot,
  ADR-0037 (CSS custom properties, no Tailwind; weekly tasks chart deferred to slice 4). Screenshot:
  `.agent/screenshots/ui1-today-390x844.png`. Deploy was denied by the auto-mode classifier.
- **Live: SP4 + Mood M1** (Worker `f5ea4843` = rollback target for the next deploy; older rollback `cae397cc`).
- **Worker launches:** codex (Flash/Pro) launches are denied by the classifier ([Create Unsafe Agents]); opencode GLM
  launches are allowed but the GLM trial FAILED (two runs exited silently without edits; provider probe answers).
  Until the owner allows codex launches, the Lead implements small slices itself.
- **Phone problem (owner, 2026-10-01):** app fails on the phone; symptom unknown. Blocks phone acceptance.
- Overnight mode until 2026-10-02 08:00 (`.agent/overnight.md`); decisions in `.agent/overnight-decisions.md`.
- Parked: stray `sp-read-latency.test.ts` change in `git stash@{0}` (reverts #52 cache expectations, origin unknown).

## Next actions (in order)

1. **Mood M2** (high-risk, Pro): brief ready in `C:\Dev\vault-companion-clones\mood-m2\.agent\brief.md` (base
   `ad1a9bb`; rebase/re-clone onto `7f49072` first). Blocked on a codex launch (owner) — do not self-implement
   (high-risk write target needs worker + Lead review).
2. **UI refresh slice 2 — Scouts board** (stat tiles, health colours, sparklines; Ready Backlog section). Ordinary;
   Lead may implement if no worker can launch. 390x844 WebKit screenshot via a temporary spec (see slice 1 PR).
3. M3 Today mood card after M2; SP3 show-last-copy (needs ADR); phone SP measurement once the phone works.

## Owner items

- Deploy #67: from `apps/worker` after a clean `pnpm build`: `wrangler versions upload --tag ui1-7f49072
  --message "UI refresh slice 1"` then `wrangler versions deploy <id>@100% --yes`; rollback `f5ea4843`.
- Allow codex worker launches (Bash permission rule) or launch Mood M2 yourself.
- Describe the phone symptom. Review ADR-0036 (Mood) and ADR-0037 (UI tokens).
- Phone acceptance (after the phone fix): Dashboard, R1 explainer, This Morning, Radar, the new dark Today.

## Budget

DeepSeek: $9.80 (owner-status 02:20). GLM-5.2: ~24k/900k local estimate (failed runs used little).
CodeRabbit CLI: 1 review used at ~02:30.
