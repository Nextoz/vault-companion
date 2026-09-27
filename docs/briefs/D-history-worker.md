# Brief D — worker instructions (Claude Cloud)

Start from branch `agent/history-base` (contract + ADR-0021 already there): `git fetch origin agent/history-base && git checkout -b agent/history origin/agent/history-base`. **Push a stub handoff within the first 5 minutes** (`git push -u origin agent/history`), then push again at the end. Do not open a PR, do not spawn agents.

Then read AGENTS.md (follow "Worker token economy"), then docs/decisions/0021-completion-history.md (the spec) and
docs/briefs/D-completion-history.md. Branch agent/history (base agent/history-base: HistoryResponse / HistoryItem /
MAX_HISTORY_ITEMS are in packages/contracts/src/index.ts). Commit on your branch. Read-only feature: no new mutation.

Build (full stack, smallest change that reuses existing code):
1. packages/domain: `createHistoryService({store, timeZone, now})` → `readHistory()`: one head X; read
   Tasks/To-Do List.md (reuse parseTodoList + the TaskView mapping used by the tasks read in commands.ts: done status,
   `done` date, locator, links) and Tasks/Active Work Now.md (reuse parseActiveWork from packages/vault-markdown:
   `## Dropped or done` item lines `- [x] … ✅ YYYY-MM-DD`; description = item name + outcome). Exclude cancelled (❌),
   undated done lines and prose entries. Sort newest date first, stable file order within a day, cap
   MAX_HISTORY_ITEMS. Absent Active Work file = no items from it. Store errors -> upstream-unavailable.
2. apps/worker: GET /api/history wired like /api/active-work (auth, no-store, no text in logs); wiring test.
3. apps/web: a "History" view (tab beside Today/All/Scouts, follow App.tsx patterns): days as headings (e.g.
   "Sat 26 Sep"), newest first; each item shows its text (wikilinks tappable via the existing linked-note path —
   both locator kinds are accepted); a **Reopen** button only for To-Do items that this device completed and still has
   a receipt for (reuse the existing Undo of CompleteTask from Done today: same queue path); other items show
   "reopen in Obsidian". No counts-as-scores, no streaks. api.ts getHistory() with .strip().
4. Tests: domain (both sources, exclusions, sort, cap, absent file, day boundaries as written), worker route,
   web unit (grouping), mock-api.ts /api/history with synthetic data, ONE Playwright spec (two days, one Reopen).
Synthetic fixtures only (e.g. "Water the plants", "Garden plan").
Verify ONLY: pnpm exec vitest run packages/domain apps/worker apps/web/src --reporter=dot 2>&1 | tail -12 ;
pnpm exec tsc -b packages/contracts packages/domain apps/worker apps/web 2>&1 | tail -8 ; pnpm --filter
web build ; pnpm --filter web exec playwright test <your spec> --workers 1 2>&1 | tail -8
Handoff .agent/handoffs/history.md (<= 15 lines). Do not edit docs/plan.md.
