# Product contract

Distilled from the accepted build contract (bootstrap §2–3, 2026-09-24). The
product owner is the final decision-maker; change this file only on an explicit
owner decision. Historical background: `docs/bootstrap/`.

## One sentence

A private, mobile-first execution layer over the existing Obsidian vault.
**Markdown + Git are authoritative**; the app never becomes a second store.

## First daily-use release (the only committed scope)

From a real phone, without AI:

1. See **Today** and **All tasks**.
2. **Complete** a task with one tap; immediate acknowledgement; calm feedback.
3. **Undo** a completion safely.
4. See **Done today**.
5. **Capture a task** (appended to the canonical To-Do List).
6. **Capture a note/thought** (new file under `Inbox/`).
7. Open/read linked note context where useful (read-only, sanitised).
8. Always see the honest state of each action:
   `draft (on this device)` → `saving` → `saved to GitHub` | `needs attention / conflict`.
   "Saved to GitHub" never implies the desktop has it.

### Acceptance story

> With the computer switched off, I open the phone app, see my tasks, finish one
> and capture a thought. A dropped connection does not lose or duplicate my
> action. When the computer returns and synchronization runs, both changes reach
> the vault. Any conflict is visible and preserves both versions.

### Today (first release definition — owner decision T1, 2026-09-25, ADR-0012)

Today is derived, not stored, and keeps four signals apart:
- **Chosen work:** `Tasks/Active Work Now.md` shown read-only above the lists. No task mapping is inferred and
  outcomes are never completed from the app.
- **Overdue** appears as a separate group **below** Today, collapsed by default; its count stays visible.
- **Available:** a start date `🛫` alone never puts a task in Today; it stays in All tasks.

Rule (T = today in `Europe/Copenhagen`), evaluated in order for each open task:
1. `📅` < T ⇒ **Overdue** (always, whatever other dates say).
2. `📅` = T ⇒ **Today** (a deadline today beats any future start/scheduled date).
3. `🛫` > T or `⏳` > T ⇒ **not Today** (not yet available/planned, even at 🔺/⏫).
4. `⏳` ≤ T ⇒ **Today**.
5. priority `🔺`/`⏫` ⇒ **Today**.
6. otherwise ⇒ All tasks only. A future `📅` alone does not hold a priority task back.

Everything open appears in All tasks. Revisit after real-phone use (the rule is a read-model change only).

### Done today

Tasks whose Tasks-parsed done date `✅` equals today's date in `Europe/Copenhagen`,
derived from Markdown on every read. No streaks, targets or scores.
Cancelled (`❌`) tasks are not "done".

## Explicitly not in the first release

Journal capture/UI, Waiting/Someday writes, Focus selection, scheduling edits,
Upcoming/Anytime/Someday views, Areas/Projects, Quick Find, Needs You, calendar,
recurrence editing, push notifications, AI, D1 index (unless justified by measured need),
bulk task IDs, archiving of old completed tasks.

## Invariants

- Completed tasks are retained in Markdown. The app never trims `## Done`.
- Completing a task ≠ completing a project/outcome.
- Completion state, priority, scheduled/start date, deadline, Focus and Waiting/Someday
  are distinct concepts; the app does not create app-only durable metadata for any of them.
- A retried action has exactly one durable effect.
- Undo is a new validated inverse command against current state, never a file restore.
- Unsupported or ambiguous Markdown ⇒ explicit refusal, never a guess.
- Recurring tasks are read-only for completion until recurrence is implemented and tested.
- Capture never requires AI or classification. Original text and URLs are preserved.
- Time: user timezone `Europe/Copenhagen`; `capturedAt` (user action instant) and `uploadedAt`
  are distinct; durable dates derive from `capturedAt` (see `vault-contract.md#time-policy`).
- The phone keeps only a small pending/draft queue — not an offline vault.

## Owner decisions still open (non-blocking)

Recorded in `docs/plan.md#open-owner-decisions`.
