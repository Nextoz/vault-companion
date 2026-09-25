# Checkpoint — 2026-09-25 (Milestone 1: integrated first-release build)

**HEAD:** `main`, clean. CI (GitHub Actions) gates every PR. Plan, milestones, workers, targets: `docs/plan.md`.

## In flight (all Claude Code Cloud; branches appear on origin when pushed)

P2-A fixes (PR #4) · P2-B offline e2e · P3-A deploy scaffold · P4-A linked notes · P4-B client correctness ·
P4-C draft recovery. Session IDs in `docs/plan.md`. Watcher: `tools/wait-for-work.sh` (background) wakes the Lead on
new branches, CodeRabbit reviews, finished CI and finished Codex logs.

## Exact next actions

1. For each pushed branch: open PR → CodeRabbit loop → CI green → read `.agent/handoffs/<brief>.md` and disposition
   every discovery in the PR comment → merge. P4-A also gets an Astra adversarial review first.
2. After PR #4 merges: run the Phase 2 gate (`docs/reviews/phase-2-review-brief.md`, Cloud Opus + Astra) and
   reconcile. Note for the gate: the real desktop worker never writes conflict markers (harness models a stricter case).
3. After P3-A merges: owner does G2 with `docs/deploy.md` (owner has a Cloudflare account); Lead deploys and verifies
   read-only against the live vault; then milestone 2 canary (G3).
4. Owner decision T1 (Today) — recommendation below; implement only after the owner chooses.

## Owner-side issue seen 2026-09-25 (vault, not app)

The desktop sync run at 14:06 stopped: "Git index already contains staged changes". Nothing reaches GitHub until the
owner commits or unstages them in the vault repo. The Lead does not modify the vault.

## T1 Today — recommended first-release behaviour (awaiting owner)

Separate four signals instead of merging them:
- **Chosen work:** `Tasks/Active Work Now.md` shown read-only at the top (already an allowed read-only context in
  `docs/vault-contract.md` §1). No task mapping inferred; outcomes are not completed from the app.
- **Today:** open tasks with `📅` = today or `⏳` ≤ today (scheduled work stays until done), or priority 🔺/⏫.
- **Overdue:** `📅` < today, as a collapsed group **below** Today ("3 overdue").
- **Available:** `🛫` ≤ today is *not* Today; such tasks stay in All tasks.

Example (today = 25 Sep): "Send invoice 📅 25 Sep" → Today · "Draft outline ⏳ 23 Sep" → Today · "Fix bike 🔺" →
Today · "Renew passport 📅 20 Sep" → Overdue (collapsed) · "Plan trip 🛫 1 Sep" → All only. Active Work Now's
outcomes appear above all of them as plain read-only text.

Differences from current code: start dates leave Today; Overdue moves below Today and collapses; `📅` uses `=` (the
Build Contract wording). Needs owner choice before `docs/product-contract.md` changes.
