# HC4 ring slots — in progress (2026-10-28)

- Released full scope (owner). Plan: `docs/briefs/HC4-plan.md`; brief `docs/briefs/HC4-ring-slots.md`; ADR-0068. Gate 3 (Access) done; deploy still needs ACTION NEEDED.
- HC4-a1 merged: metric registry `ring-metrics.ts`, strict parser/canonical slot_start/month split `ring-slots.ts`, v1 helpers moved to `health-format.ts`.
- Next: HC4-a2 (`ring-slot-file.ts`, `ring-daily.ts`, see plan "a2 delta"), then HC4-b (write path, high-risk, Opus diff review), HC4-c (read API), HC4-d (design A stacked strips, mockup in docs/mockups/2026-10-28/).
- Open decisions noted in the plan: `generatedAt` freshness bound (replay of old bodies is harmless, no erase), negative `tempC` refused.
# AI leaderboard — release verification

- Branch `feat/glm-workflow-leaderboard` in isolated clone `glm-workflow-20261015`; original drafts preserved. Integrated main through `2de19209`.
- Implemented all-page Artificial Analysis ingestion, bounded refresh, durable current/previous KV snapshots, authenticated storage-only API, daily cron and mobile Dashboard/model details. Existing cron budget includes provider and storage operations. Missing fields remain unavailable.
- Standalone controller/runner: 58 offline tests passed; independent live GLM infrastructure review passed. Actual detached leaderboard launch stopped safely when OpenCode produced no final answer. State and usage retained outside repository; no worker remains active and no paid repair loop was restarted. Owner requested local repairs and CodeRabbit as release reviewer.
- Owner approved 2026-10-16: created leaderboard KV namespace, set production GitHub secret `LEADERBOARD_KV_NAMESPACE_ID`, and added Worker secret `AA_API_KEY` from existing local environment. Identifiers/values are not committed. Previous live application tag `2de19209`; setting the secret did not publish feature code.
- Verification: focused source/API/UI tests, 58 controller tests, lint, typecheck, web/Worker bundle dry run and dependency audit passed. Initial full application run: 3,040 passed, one CSS-token failure fixed and its check passed. Final full run, complete browser suite and screenshot tour are in progress.
- Next: finish verification, address CodeRabbit/CI findings, then merge and deploy under the owner's existing authorization. Do not restart the GLM implementation job or expose secrets. Durable run receipts remain in the local workspace.
