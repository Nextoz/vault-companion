# GitHub Git Data API probe (Phase 1 gate follow-up) — 2026-09-25

Sandbox `Nextoz/vault-companion-sandbox` (G1, synthetic). Script: `tools/spikes/github-gitdata-probe.mjs`.

## Conclusions

| Case | Real behaviour | Used by |
|---|---|---|
| blob → tree (`base_tree` of X) → commit (parent X) | 201 each, no ref moves | ADR-0011 write path |
| `PATCH git/refs/heads/main {force:false}` fast-forward from X | 200 | ADR-0011 |
| same, but head has moved past X | **422 `Update is not a fast forward`**, head unchanged | head-CAS failure ⇒ re-dedupe |
| **A2 ABA**: later commit restores identical bytes, then a delayed commit parented on original X | **422 — rejected** | closes review A2 |
| `GET git/trees/<commit>:<dir>` | 200, entries + `truncated` flag | Inbox listing at X (A4, R8) |
| `compare/base...head` without `page`, 260 commits | returns the **newest 250** (0–9 missing) | never rely on the unpaged response |
| `compare?per_page=250&page=1` / `page=2` | oldest 250 / remaining 10 | page until all `total_commits` seen (R9) |
| Case-variant paths from G1 P9, `git clone` on Windows | `warning: the following paths have collided … only one … is in the working tree` | real evidence for F7/A4 |

## Raw output

```text

### Q1 blob/tree/commit on parent X (no ref move)
{"blob":201,"tree":201,"commit":201,"sha":"6c37469f9d065b51511f3babd4c9a70642546a7e","blobSha":"cc8962429b7981524a0e14eb72a5d369116bf940"}

### Q2 fast-forward ref update X -> c1 (force:false)
200 {"ref":true}

### Q3 stale: commit parented on X (not current head) -> ref update must be rejected
422 {"message":"Update is not a fast forward"} head unchanged: true

### Q4 ABA shape: restore identical bytes in a later commit, then try a delayed commit parented on the ORIGINAL X
delayed ref update 422 {"message":"Update is not a fast forward"}

### Q5 tree listing of a directory at a commit (for Inbox collision check)
trees by commit:path 200 {"truncated":false,"entries":[{"path":"Note 1 - 2026-09-25.md","type":"blob"},{"path":"Note 2 - 2026-09-25.md","type":"blob"}]}

### Q6 compare pagination beyond 250 commits (push 260 tiny commits via local git)
warning: the following paths have collided (e.g. case-sensitive paths
on a case-insensitive filesystem) and only one from the same
colliding group is in the working tree:

  'Inbox/Første idé - 2026-09-24.md'
  'Inbox/første idé - 2026-09-24.md'
  'run-2026-09-24T202155177Z/Inbox/Første idé - 2026-09-24.md'
  'run-2026-09-24T202155177Z/Inbox/første idé - 2026-09-24.md'
compare (default) 200 {"total_commits":260,"returned":250,"first":"probe bulk 10","last":"probe bulk 259","hasEarlyOp":false}
compare?per_page=250 200 {"total_commits":260,"returned":250,"first":"probe bulk 0","last":"probe bulk 249","hasEarlyOp":true}
compare?per_page=100&page=2 200 {"total_commits":260,"returned":100,"first":"probe bulk 100","last":"probe bulk 199","hasEarlyOp":false}
compare?per_page=250&page=2 200 {"total_commits":260,"returned":10,"first":"probe bulk 250","last":"probe bulk 259","hasEarlyOp":false}
commits list 200 {"returned":100}
```
