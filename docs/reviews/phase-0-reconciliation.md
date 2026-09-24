# Phase 0 review reconciliation (Lead)

Review: `phase-0-architecture-review.md` (fresh-context Opus 5.5, PASS WITH FIXES, 24 findings).
All findings accepted. Where they landed:

| Finding | Resolution | Where |
|---|---|---|
| F1 Critical dedupe/read at different HEADs | Pin each attempt to one commit X; dedupe `base..X`, read at ref X, CAS; test A25 | commands.md, ADR-0005, VaultStore port |
| F2 duplicate twin resolved after change | `occurrencesAtRead`; replay only if 1; A26 | vault-contract §3, ADR-0003 |
| F3 Undo not byte-exact | exact inverse splice when blob = result blob; else non-blank anchor + blank count | vault-contract §4.1–4.2 |
| F4 Undo while pending / reordering | Undo = dependent queued command; never discard an ever-sent item; A27 | commands.md queue |
| F5 client-supplied Undo text | Undo carries the target envelope; server verifies hash and re-derives effect by replay; A28 | commands.md |
| F6 conflict markers / most common conflict | `refused:vault-conflict` + banner now; W4 representation explicit; **D4 promoted to owner decision before Phase 2** | vault-contract §2, sync.md, plan.md |
| F7 case-insensitive Inbox collisions | casefold+NFC listing check; A30; `listDir` added to port | vault-contract §4.5 |
| F8 control chars / YAML injection | sanitisation + quoted `context`; A31 | vault-contract §4.3, §4.5 |
| F9 compare truncation / history rewrite | tri-state `findOperation`, `dedupe-unknown`; ruleset recommendation at G2; A32 | commands.md, sync.md |
| F10 state wording / stale reads | `pending` vs `saving`; no retry limit; `known=` overlay; A33 | commands.md, sync.md |
| F11 Access expiry looks like offline | `redirect: 'manual'`, `signed-out` state; A24; early iPhone spike in Phase 1 | commands.md, testing.md |
| F12 linked-note reader too open | server-side resolution from task line, allowlist roots | vault-contract §1 |
| F13 block IDs, `🏁` | ✅ before `^id`; `🏁` refused; A34 | vault-contract §2, §4.1 |
| F14 structural ambiguity | duplicate/missing headings, subheadings in Open, comment blocks; A35 | vault-contract §2 |
| F15 unprobed GitHub semantics | **G1 requested now**; InMemoryStore marked "assumed" | plan.md, testing.md |
| F16 EOF edges / codes | final-newline rules; complete code list | vault-contract §4, §5 |
| F17 Drive as writer | W6 | sync.md |
| F18 payload hash stability | JCS over raw body + `schemaVersion` | commands.md |
| F19 double-tap | op ID persisted before send; control disabled; A40 | commands.md |
| F20 path leaks title | paths hashed in logs; sentinel in note first line | security.md |
| F21 missing scenarios | A36–A38 + explicit N/A list | testing.md |
| F22 > 1 MB | raw media type + `refused:too-large`; A39 | vault-contract §1 |
| F23 open-file clobber | canary checklist | sync.md |
| F24 README drift | fixed | README.md |

Also adopted: optional `context` on `CaptureTask` (bootstrap §3.4).
