# Checkpoint — 2026-10-02 06:55 (UI refresh 1–5 + SP3a/b/c + SP1 measure merged, not deployed)

Overwrite this file at milestones only. ≤ 40 lines. Policy lives in `docs/orchestration.md`, not here.

## State

- **Merged, NOT deployed: SP1 measure #83** (main `0e5b3cc`): every Worker response has `Server-Timing: app;dur=N`;
  the Vault status details (tap the "Vault updated" line) list the last read per route, phone ms and server ms.
  Screenshot `.agent/screenshots/sp1-read-speed-390x844.png`. GitHub time is not split (shared store caches).
- **Merged, NOT deployed:** SP3c #81 (Dashboard copy per range), SP3b #79 (Progress copy), SP3a #77 (Notes/note/Training
  copy, ADR-0038 memory only, never editable, sign-out clears), UI refresh #67 #69 #71 #73 #75 (ADR-0037). Details in
  `.agent/overnight-decisions.md`; screenshots `.agent/screenshots/`. Production deploys are denied by the auto-mode
  classifier — owner deploys.
- **Live: SP4 + Mood M1** (Worker `f5ea4843` = rollback target for the next deploy; older rollback `cae397cc`).
- **Worker launches:** codex (Flash/Pro) launches are denied by the classifier ([Create Unsafe Agents]); GLM trial
  FAILED (two silent exits). Until the owner allows codex launches, the Lead implements small ordinary slices itself.
- **Phone problem (owner, 2026-10-01):** app fails on the phone; symptom unknown. Blocks phone acceptance.
- Overnight mode until 08:00 (`.agent/overnight.md`), decisions in `.agent/overnight-decisions.md`. Parked: stray `sp-read-latency.test.ts` change in `git stash@{0}` (reverts #52 cache expectations, origin unknown).

## Next actions (in order)

1. **Morning report** (`.agent/overnight-report.md`, summary here): the overnight window ends 08:00 and no remaining
   item fits it — Mood M2 is blocked on a codex launch; SP remainder is the owner's phone measurement (SP1 panel)
   and task last-copy (high-risk, own review, not overnight). RAM was 2.6 GB free at 06:52: no e2e/worker below 3 GB.
2. **Mood M2** (high-risk, Pro): brief in `C:/Dev/vault-companion-clones/mood-m2/.agent/brief.md` (base `ad1a9bb`;
   re-clone onto main). Blocked on a codex launch (owner) — do not self-implement.
3. SP: after the owner's phone timings, target the slowest route; Today/task last-copy only with its own review.
4. M3 Today mood card after M2.

## Owner items

- Deploy main `0e5b3cc` (#67 + #69 + #71 + #73 + #75 + #77 + #79 + #81 + #83): from `apps/worker` after a clean `pnpm build`: `wrangler versions upload
  --tag sp1-0e5b3cc --message "UI refresh 1-5 + SP3a/b/c + SP1"` then `wrangler versions deploy <id>@100% --yes`; rollback `f5ea4843`.
- Allow codex worker launches (Bash permission rule) or launch Mood M2 yourself.
- After deploy: open Today → tap "Vault updated" → note the read-speed list for a few tabs (SP measure).
- Describe the phone symptom. Review ADR-0036 (Mood), ADR-0037 (UI tokens), ADR-0038 (last copy).
- Phone acceptance (after the phone fix): Dashboard, R1 explainer, This Morning, Radar, the new dark Today + Scouts + Dashboard/Weather + Training + Progress + Notes/Radar/sheets.

## Budget

DeepSeek: $9.80 (05:36). GLM-5.2: ~24k/900k local estimate. CodeRabbit CLI: reviews at ~04:35 and ~05:08. Jev: one call hung >15 min at 04:55 (SP3b scope; killed at its time limit); SP3c needed no Jev call; SP1 one Jev scope call (answered).
