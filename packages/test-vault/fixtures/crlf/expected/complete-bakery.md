---
title: To-Do List
aliases:
  - Todo
  - Tasks
tags:
  - tasks
  - planning
---

This note is the one list of things to do. Everything else is reference; the checkbox is what counts, not the section.

## Short answer

Open items live under Open. Finished and cancelled items move to Done, newest first.

```tasks
not done
tag includes #todo
- [ ] Fake task inside the query block #todo ➕ 2026-01-01
```

## How to add

Type `- [ ] Something #todo ➕ 2026-09-01` under Open, or use the capture command.
- Example line: `- [ ] Water the plants #todo 📅 2026-09-30 ➕ 2026-09-01`
- Priorities: `🔺` highest, `⏫` high, `🔼` medium. Inline `%%` and `<!--` in code are not comments.

~~~
- [ ] Tilde fenced example #todo
## Open
~~~

%%
- [ ] Commented out task #todo ➕ 2026-02-02
## Done
%%

<!--
- [ ] HTML commented task #todo
## Open
-->

## Open

- [ ] Water the plants #todo 📅 2026-09-30 ➕ 2026-09-01
- [ ] Call the bike shop about the gears #todo ⏫️ ➕ 2026-09-02

- [ ] Plan the trip with [[Projects/Summer Trip|the trip plan]] #todo 🔺 📅 2026-10-01 ⏳ 2026-09-28 🛫 2026-09-26 ➕ 2026-09-10
- [ ] Sort the receipts #todo ➕ 2026-09-04
- [ ] Sort the receipts #todo ➕ 2026-09-04
- [x] Return the library books #todo ➕ 2026-09-01 ✅ 2026-09-05
- [ ] Draft the garden plan #todo ➕ 2026-09-05
    - Measure the beds
    - Pick seeds

    - Order compost
- [ ] Take out the recycling #todo 🔁 every week ➕ 2026-09-06
- [ ] Renew the parking permit #todo 🆔 park01 ➕ 2026-09-07
- [ ] Book the dentist 🔼 #todo ➕ 2026-09-08 🛫 2026-09-20 📅 2026-09-25 ^dentist
- [ ] Ship the parcel #todo 🏁 delete ➕ 2026-09-09
- [ ] Pay the water bill #todo 📅 2026-09-20 📅 2026-09-21
- [/] Paint the fence #todo ➕ 2026-09-10
- [ ] Read about `- [ ] fake` syntax #todo ➕ 2026-09-11
    - [ ] Child task stays with the parent #todo
- [ ] Not a todo item without the tag ➕ 2026-09-12

## Done

_Completed and cancelled items move here, newest first. Trim to ~20._

- [x] Buy rugbrød, smør og æbler at the bakery 🥐 #todo ➕ 2026-09-03 ✅ 2026-09-24
- [x] Fixed the bike light #todo ➕ 2026-09-01 ✅ 2026-09-20
- [x] Ordered new plates #todo ➕ 2026-09-02 ❌ 2026-09-22 afløst af nyt
- [x] Called the landlord #todo ✅ 2026-09-19 (took two tries)

- [x] Old cancelled thing #todo ❌ 2026-09-18
- [x] Mid ❌ 2026-09-17 cancelled marker #todo ✅ 2026-09-17
- [ ] Open item left in Done #todo ➕ 2026-09-12

## Format reference

| Field | Emoji | Example |
|---|---|---|
| due | 📅 | `📅 2026-09-30` |
| done | ✅ | `✅ 2026-09-24` |

Ending prose with æøå and a compass 🧭.
