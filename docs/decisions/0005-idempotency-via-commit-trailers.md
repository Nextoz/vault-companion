# ADR-0005 Idempotency and receipts via Git commit trailers

Status: Accepted

**Context.** Critical failure: the commit succeeds but the HTTP response is lost. D1 must not be the only
evidence of what was committed.

**Decision.** Each app commit carries `Vault-Companion-Op` and `Vault-Companion-Payload` trailers.
Undo commits also carry `Vault-Companion-Undoes` with the target completion's operation ID, preventing a second Undo.
Each attempt pins one commit X; the dedupe searches `baseRevision..X` and the file is read at X.
A commit that advances the branch after X and before this attempt's publication makes head-CAS fail and
forces a new attempt. An unknown ref-update outcome starts a new attempt, which repeats dedupe at the
newly resolved head before deciding whether to write. The search
returns found / not-found / **unknown**; unknown never writes. Same payload ⇒ `already-applied` receipt; different ⇒
`operation-id-reused`. Algorithm in `docs/commands.md`.

**Consequences.** Correct after server restarts and with no database. Depends on sync worker W1 (no
history rewrite). Costs one compare call per command — acceptable for a single user. Commit messages
must never contain personal text.

**Superseded in part by [ADR-0011](0011-head-cas-writes.md)** (2026-09-25): writes are CAS on the branch head,
with `expect: 'absent' | 'regular-file'` checked in the pinned tree; a failed precondition is
`refused:structure`, never retried.
