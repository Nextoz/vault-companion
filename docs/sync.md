# Synchronization contract

## Topology

```text
 phone (PWA) ──HTTPS──> Worker API ──GitHub App (Contents API)──> GitHub: <owner>/<vault-repo>@main
                                                                        ▲   │
                                                  scheduled local worker│   │ (hourly)
                                                                        │   ▼
                                                  desktop checkout (Obsidian working copy)
                                                  Google Drive mirror ← backup only, never on this path
```

- **Durable:** Markdown files + Git history. GitHub `main` is the app's remote durable write endpoint.
- **Desktop and GitHub may each be ahead.** A phone write committed to GitHub is a valid save while
  the desktop is off. It is *not* evidence the desktop has it.
- **Disposable:** any cache, projection or index.

## States the UI may claim

| State | Evidence required |
|---|---|
| `pending` ("On this device") | Stored in this device's queue; no request in flight. |
| `saving` | A request is in flight right now. |
| `saved` ("Saved to GitHub") | A receipt with `commitSha` from the Worker, or a dedupe hit (trailer found). |
| `attention` | Conflict/refusal/`dedupe-unknown` returned, or session/account mismatch. |
| `signed-out` | Access session expired; queue paused until re-authentication. |

Never shown in the first release: "on your computer", "synced to desktop", or local worker
health — no transport for that evidence exists or is approved.

## App write path invariants

1. Every write is a single-file commit parented on pinned X, published by a fast-forward-only ref update
   (head-CAS); `expect: 'absent' | 'regular-file'` is checked in X before writing. A failed precondition
   returns `refused:structure`, never retried. See [ADR-0011](decisions/0011-head-cas-writes.md).
2. Each commit message carries trailers:
   `Vault-Companion-Op: <operationId>` and `Vault-Companion-Payload: sha256:<hex>`.
   Undo commits also carry `Vault-Companion-Undoes: <target operationId>`.
   Commit subject and body never contain task text or note text.
3. The app never force-pushes, rewrites history, deletes branches, or writes outside allowed paths.
4. On CAS failure the command re-reads and re-evaluates the *semantic* command against the new
   content (safe replay per `vault-contract.md` §3), at most 5 attempts, then `conflict:stale`.

## Requirements on the desktop sync worker (owned in the vault, not this repo)

The app's correctness assumes these; the canary (Phase 3) must show them on the real worker:

- W1 Never rewrites or force-pushes published history (app commits and trailers must stay reachable).
- W2 Commits local edits before integrating remote changes, or otherwise never blocks indefinitely
  on "local changes would be overwritten" (spike S4/S5: the **snapshot** worker does block).
- W3 Integrates compatible divergence (spike S6: non-adjacent edits merge cleanly).
- W4 On textual conflict, preserves both versions and surfaces the conflict to the owner; never
  resolves by discarding either side. Note spike S5b: concurrent appends at the end of `## Open`
  (QuickAdd on desktop + app capture) are a **textual conflict** even though semantically
  compatible — expect this to be the most common real conflict.
- W5 Google Drive unavailability does not affect Git synchronization.
- W6 The Drive mirror is strictly one-way out of the working copy; recovery from Drive goes through a
  reviewed Git commit, never an in-place restore the worker would commit (review F17).
- W4 representation must be explicit (markers committed vs. conflict-copy file vs. blocked sync). The app
  refuses all writes to a file containing conflict markers (`refused:vault-conflict`) and shows a banner.

Recommended enforcement of W1 on GitHub (owner action, gate G2): a ruleset on `main` blocking force-push and
deletion. Canary checklist adds: pull while `To-Do List.md` is open/being edited in Obsidian — no clobber (F23).

Status: the Codex-updated worker (`VaultGitSync.psm1`, 17 reported passing cases) claims W1–W5
but is **not in the reference snapshot**; unverified here. Verify at the canary gate.

## Round trips to prove

| Direction | Disposable proof (Phase 2) | Live proof (Phase 3 canary, gated) |
|---|---|---|
| app → GitHub → desktop | local bare repo + desktop clone + worker-equivalent integration | real GitHub + real worker |
| desktop → GitHub → app | desktop clone commit/push → app re-read | controlled Obsidian edit |
| conflict | same-task and same-anchor cases | one controlled conflict |

## Lost-response recovery

See `docs/commands.md`. Git (trailers) is the evidence; no database is required to decide
whether an operation already committed.
