# Checkpoint — 2026-10-02 05:15 (UI refresh 1–5 + SP3a + SP3b merged, not deployed)

Overwrite this file at milestones only. ≤ 40 lines. Policy lives in `docs/orchestration.md`, not here.

## State

- **Merged, NOT deployed: SP3b #79** (main `5cf4a15`): Progress opens from its last copies (one note, oldest copy);
  a copied history offers no Reopen. Dashboard deferred to SP3c. Screenshot `.agent/screenshots/sp3b-progress-copy-390x844.png`.
- **Merged, NOT deployed: SP3a #77** (main `298c425`): Notes list, a note and Training reopen from an in-memory last copy,
  labelled "Showing the copy from HH:MM · refreshing…" / "Could not refresh · …"; a copy is never editable; any sign-out
  clears (ADR-0038, memory only). Screenshot `.agent/screenshots/sp3-note-copy-390x844.png`.
- **Merged, NOT deployed: UI refresh slices 1 #67, 2 #69, 3 #71, 4 #73, 5 #75** (dark iOS tokens, ADR-0037; details in
  `.agent/overnight-decisions.md`; screenshots `.agent/screenshots/ui*`). Production deploys are denied by the
  auto-mode classifier — owner deploys.
- **Live: SP4 + Mood M1** (Worker `f5ea4843` = rollback target for the next deploy; older rollback `cae397cc`).
- **Worker launches:** codex (Flash/Pro) launches are denied by the classifier ([Create Unsafe Agents]); GLM trial
  FAILED (two silent exits). Until the owner allows codex launches, the Lead implements small ordinary slices itself.
- **Phone problem (owner, 2026-10-01):** app fails on the phone; symptom unknown. Blocks phone acceptance.
- Overnight mode until 2026-10-02 08:00 (`.agent/overnight.md`); decisions in `.agent/overnight-decisions.md`.
- Parked: stray `sp-read-latency.test.ts` change in `git stash@{0}` (reverts #52 cache expectations, origin unknown).

## Next actions (in order)

1. **Mood M2** (high-risk, Pro): brief ready in `C:/Dev/vault-companion-clones/mood-m2/.agent/brief.md` (base
   `ad1a9bb`; rebase/re-clone onto main first). Blocked on a codex launch (owner) — do not self-implement.
2. **SP3c**: Dashboard adopts `useLastCopy` (key per range; the ticker merge stays live-only; a copy shows no
   drill-through actions that write). Ordinary, Lead may implement. Then SP remainder per the backlog.
3. M3 Today mood card after M2.

## Owner items

- Deploy main `5cf4a15` (#67 + #69 + #71 + #73 + #75 + #77 + #79): from `apps/worker` after a clean `pnpm build`: `wrangler versions upload
  --tag sp3b-5cf4a15 --message "UI refresh 1-5 + SP3a/b"` then `wrangler versions deploy <id>@100% --yes`; rollback `f5ea4843`.
- Allow codex worker launches (Bash permission rule) or launch Mood M2 yourself.
- Describe the phone symptom. Review ADR-0036 (Mood), ADR-0037 (UI tokens), ADR-0038 (last copy).
- Phone acceptance (after the phone fix): Dashboard, R1 explainer, This Morning, Radar, the new dark Today + Scouts + Dashboard/Weather + Training + Progress + Notes/Radar/sheets.

## Budget

DeepSeek: $9.80 (05:15). GLM-5.2: ~24k/900k local estimate. CodeRabbit CLI: reviews at ~04:35 and ~05:08. Jev: one call hung >15 min at 04:55 (SP3b scope); decided without it.
