# ADR-0005 Idempotency and receipts via Git commit trailers

Status: Accepted

**Context.** Critical failure: the commit succeeds but the HTTP response is lost. D1 must not be the only
evidence of what was committed.

**Decision.** Each app commit carries `Vault-Companion-Op` and `Vault-Companion-Payload` trailers.
Each attempt pins one commit X; the dedupe searches `baseRevision..X` and the file is read at X, so any later
commit to the file (including our own) fails the blob CAS and forces a new attempt (review F1). The search
returns found / not-found / **unknown**; unknown never writes. Same payload ⇒ `already-applied` receipt; different ⇒
`operation-id-reused`. Algorithm in `docs/commands.md`.

**Consequences.** Correct after server restarts and with no database. Depends on sync worker W1 (no
history rewrite). Costs one compare call per command — acceptable for a single user. Commit messages
must never contain personal text.

**Superseded in part by ADR-0011** (2026-09-25): writes are CAS on the branch head, not the file blob.
