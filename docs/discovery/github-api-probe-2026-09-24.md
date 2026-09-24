# GitHub API probe (gate G1) — 2026-09-24

Owner-approved private sandbox `Nextoz/vault-companion-sandbox` (kept). Synthetic content only.
Script: `tools/spikes/github-api-probe.mjs`. Raw output below (token never printed).

## Conclusions used by `packages/github/src/contents-store.ts`

| Case | Real behaviour | Mapping |
|---|---|---|
| PUT create, path exists (no `sha`) | 422 `Invalid request.\n\n"sha" wasn't supplied.` | `exists` |
| PUT update without `sha` | 422 (same body) | never sent by the app |
| PUT stale/unknown `sha` | 409 `<path> does not match <sha>` | `cas-mismatch` |
| Concurrent PUTs to **different** files | 409 `is at <X> but expected <Y>`; loser **not applied** (P12b) | `cas-mismatch` (executor re-dedupes and re-plans) |
| Commit message | trailing newline stripped; trailer block intact | `parseTrailers` |
| Read-after-write | ref, compare and `contents?ref=main` reflected each PUT immediately (8/8) | evidence for review F1 assumption, not a guarantee |
| Contents GET `sha` / `ETag` | blob SHA; base64 with `\n` | as captured in Phase 0 |
| > 1 MB | object media type: `encoding: none`, empty `content`; raw media type: full bytes, `ETag` = blob SHA | refuse (`refused:too-large`); raw is a possible future path |
| Compare | `ahead` + `total_commits`; reversed ⇒ `behind`; unknown base ⇒ 404 | non-`ahead`/`identical` ⇒ `unknown` |
| Case-variant path create | accepted (201) | app must check casefold collisions itself (review F7) |
| `commits/{sha}` | `files[].filename` present | changed paths for dedupe |

## Raw output

```text

### P1 create file without sha
201 {"content":{"path":"run-2026-09-24T202155177Z/Tasks/To-Do List.md","sha":"cc8962429b7981524a0e14eb72a5d369116bf940","size":38},"commit":{"sha":"b921ebcc018543aa1df08013c2680cad191cd404","message":"probe: seed\n\nVault-Companion-Op: probe-1\nVault-Companion-Payload: sha256:aa","parents":["87b48f7a35f3d00aff328ba5b8e8f69524a0607c"]}}

### P2 create again without sha (create-over-existing)
422 {"message":"Invalid request.\n\n\"sha\" wasn't supplied.","status":"422"}

### P3 update with correct sha
200 {"blob":"cc155dc46818d20af4e15a5873d753c7e9e23f05","commit":"682c33dee7bb26e3d33c662fc7acbcd8e88a68c3"}

### P4 update with stale sha (true CAS loss)
409 {"message":"run-2026-09-24T202155177Z/Tasks/To-Do List.md does not match cc8962429b7981524a0e14eb72a5d369116bf940","status":"409"}

### P5 update with a well-formed unknown sha
409 {"message":"run-2026-09-24T202155177Z/Tasks/To-Do List.md does not match ffffffffffffffffffffffffffffffffffffffff","status":"409"}

### P5b update WITHOUT sha on an existing file
422 {"message":"Invalid request.\n\n\"sha\" wasn't supplied.","status":"422"}

### P6 read pinned to the seed commit
200 {"sha":"cc8962429b7981524a0e14eb72a5d369116bf940","size":38,"encoding":"base64","etag":"\"cc8962429b7981524a0e14eb72a5d369116bf940\"","contentHasNewlines":true,"decoded":"## Open\n\n- [ ] Water the plants #todo\n"}

### P6b read of a path absent at that ref
404 {"message":"Not Found","status":"404"}

### P7 Unicode path with space and æ
201 {"path":"run-2026-09-24T202155177Z/Inbox/Første idé - 2026-09-24.md","name":"Første idé - 2026-09-24.md"}

### P8 list a directory
200 [{"name":"Første idé - 2026-09-24.md","type":"file"}]

### P9 case-variant create (collides on Windows)
201

### P10 compare seed...HEAD
200 {"status":"ahead","ahead_by":3,"behind_by":0,"total_commits":3,"n":3,"firstMsg":"probe: update","filesPresent":true}

### P10b compare reversed (HEAD...seed)
200 {"status":"behind","ahead_by":0,"behind_by":3,"total_commits":0}

### P10c compare with unknown base
404 {"message":"Not Found","status":"404"}

### P10d seed commit message (trailers) via git/commits
200 "probe: seed\n\nVault-Companion-Op: probe-1\nVault-Companion-Payload: sha256:aa"

### P10e commits/{sha} files list
200 [{"filename":"run-2026-09-24T202155177Z/Tasks/To-Do List.md","status":"added"}]

### P11 read-after-write: ref, compare and contents immediately after PUT (8 rounds)
round 1 put=201 refIsNewCommit=true trailerInCompare=true contentsMainFresh=true
round 2 put=200 refIsNewCommit=true trailerInCompare=true contentsMainFresh=true
round 3 put=200 refIsNewCommit=true trailerInCompare=true contentsMainFresh=true
round 4 put=200 refIsNewCommit=true trailerInCompare=true contentsMainFresh=true
round 5 put=200 refIsNewCommit=true trailerInCompare=true contentsMainFresh=true
round 6 put=200 refIsNewCommit=true trailerInCompare=true contentsMainFresh=true
round 7 put=200 refIsNewCommit=true trailerInCompare=true contentsMainFresh=true
round 8 put=200 refIsNewCommit=true trailerInCompare=true contentsMainFresh=true

### P12 concurrent PUTs to different files on the same branch
race-1 201 {}
race-2 409 {"message":"is at c30497f6265d5437fd32a384079d1cafe5938a3b but expected 05b9ce4ee3ce265bf32057041889dd18bc0fcfdc"}
race-3 409 {"message":"is at c30497f6265d5437fd32a384079d1cafe5938a3b but expected 05b9ce4ee3ce265bf32057041889dd18bc0fcfdc"}
race-4 409 {"message":"is at c30497f6265d5437fd32a384079d1cafe5938a3b but expected 05b9ce4ee3ce265bf32057041889dd18bc0fcfdc"}

### P12b were the 409 losers applied anyway?
race-1 exists=true
race-2 exists=false
race-3 exists=false
race-4 exists=false

### P13 file > 1 MB
put 201
object 200 {"size":1100000,"encoding":"none","contentLen":0,"etag":"\"95c1ea7622e9edaa07391f1d831f8c5a5111f532\""}
raw 200 {"len":1100000,"etag":"\"95c1ea7622e9edaa07391f1d831f8c5a5111f532\""}
```
