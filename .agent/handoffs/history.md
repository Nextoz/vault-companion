# Handoff — D completion history (branch agent/history, base agent/history-base ce52771)

Status: DONE, not pushed. The clone had no `origin` remote and adding one was blocked, so the Lead must push.
- kernel: `parseActiveWork` now returns `doneItems` (`## Dropped or done` `- [x] … ✅ date`, parsed with the existing item grammar; `❌`, prose and hidden lines excluded).
- domain `history.ts`: `createHistoryService({store,timeZone,now}).readHistory()` makes 1 head and 2 reads (it reuses `readTodo`/`toView`, now exported from commands.ts). It sorts newest first (stable: To-Do then AW within a day) and caps at MAX_HISTORY_ITEMS. Absent AW adds no items. Store errors ⇒ upstream-unavailable.
- linked-notes.ts: an AW link regex now allows the trailing ` ✅ YYYY-MM-DD`, so done items open their note.
- worker: GET /api/history is wired like /api/active-work (optional service, no-store, no text in logs), with a route test and a wiring.test line.
- web: History tab, `history.ts` (groupByDay, dayHeading "Sat 26 Sep" in UTC calendar maths, reopenFor), `ui/History.tsx`, and `api.getHistory()` with .strip(). Reopen reuses App `undo` (same queue path). The pairing matches Done today: unique text, own account, a receipt must be held; otherwise it shows "reopen in Obsidian".
- tests: kernel, domain history, linked-note done-link, worker route, web unit, mock `/api/history`, and e2e/history.spec.ts.
Verify: vitest domain+vault-markdown+worker+web 54 files / 893 tests pass. tsc -b, eslint and the web build are clean.
e2e: the container has no WebKit, so history.spec, app.spec and scouts.spec were run under Chromium (Pixel 7) with a temp config: 36/36 pass. The Lead should run them on WebKit.
Choices to check:
- AW description is "Name: outcome [[link]]" so the existing taskSegments makes the link tappable.
- A too-large or non-UTF-8 Active Work file refuses the whole read rather than hiding it.
- The history read does not listFiles-check that AW is a regular file (2-read budget), unlike /api/active-work.
