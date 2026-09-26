# Brief C — Active Work in the app (owner-approved 2026-09-26)

Read `AGENTS.md` (incl. "Worker token economy"). Synthetic data only. Priority/decisions live in the owner's Ready
Backlog; this brief is the synthetic engineering copy.

**Outcome:** on the phone the owner sees only current Active Work items, can add one, edit one, and review items
that are no longer relevant.

## File shape (`Tasks/Active Work Now.md`, synthetic example)

```markdown
## Now
- [ ] **Garden plan:** beds ready for spring. Next: order seed catalogue ⏳ 2026-10-03 [[Garden Plan]]
- [ ] **Bike repair:** commuting again. Next: call the shop

## Parked
- [ ] **Language course:** A2 by summer. Next: pick a course

## Dropped or done
- [x] **Tax return:** filed. Next: none ✅ 2026-09-20
- [ ] **Old side project:** paused. Next: none ❌ 2026-09-18 no longer relevant

## Rules
Free text the owner keeps by hand.
```

One line per item: `- [ ] **Name:** outcome. Next: next action ⏳ YYYY-MM-DD [[optional link]]`; `outcome`, `Next:`,
`⏳` and the link are each optional. No item limit.

## Build

1. **Read:** the Active Work card shows only `## Now` items: name, next action, review date, link (tappable via the
   existing linked-note path). A line the parser does not understand is shown read-only with the hint "edited in
   Obsidian" — never dropped or rewritten.
2. **Add:** Capture gets an **Active Work** choice beside Task and Note. Fields: name (required), next action,
   review date (prefilled today + 7, editable, clearable), link. Save appends one line at the end of `## Now`.
3. **Edit:** reuse increment B's edit sheet (name, next action, review date) for Active Work items.
4. **Review:** an item whose ⏳ date is before today (Europe/Copenhagen) shows **Needs review** (derived; the app
   never moves lines by itself). Actions, each with Undo:
   - Keep → ⏳ + 7 days;
   - Done → line moves to `## Dropped or done` as `- [x] … ✅ YYYY-MM-DD`;
   - Park → line moves to `## Parked`;
   - Drop → short reason required; line moves to `## Dropped or done` as `- [ ] … ❌ YYYY-MM-DD <reason>`.
   Items without ⏳ never show Needs review.
5. **Unchanged:** task capture (`Tasks/To-Do List.md`) and note capture (`Inbox/`); the note save status clearly says
   "saved to the vault".

## Rules

- **ADR first** (next free number): vault-contract §7 today forbids writes to this file and
  `packages/domain/src/active-work.ts` is read-only. The ADR allows **only minimal line edits** inside `## Now`,
  `## Parked`, `## Dropped or done`, with the same locator/CAS/dedupe/trailers/exact-once path as task writes
  (ADR-0003/0005/0011/0015) and new command types in `packages/contracts`.
- A move between sections is one file, two locations: golden-diff tests prove nothing else changes (BOM, EOL, final
  newline, unknown lines and sections byte-for-byte). A missing target section is created only when needed.
- `✅` lines must stay readable for increment D.
- Out of scope: AI suggestions, automatic moves, notifications, limits, reordering.

## Done means

1. The card shows only `## Now` items from the real note.
2. An item added from Capture appears in Obsidian as one correctly formatted line.
3. A passed-date item shows Needs review; Keep/Done/Park/Drop each give the expected minimal diff; Undo restores.
4. An oddly formatted hand-edited line is read-only and survives every app write unchanged.
5. Gates: adversarial review of the new mutations (Astra high or CodeRabbit), e2e with real Git, owner phone test.

Trial: the review-date mechanism is an experiment; the owner decides after ~2 weeks.
