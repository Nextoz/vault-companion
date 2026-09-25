# ADR-0011 Writes are compare-and-swap on the branch head, not the file blob

Status: Accepted — Phase 1 gate (review A2 Critical, A4 High), 2026-09-25. Supersedes the blob-CAS part of ADR-0005.

**Context.** Blob CAS (Contents API `PUT sha=`) has an ABA hole: if a later commit restores identical file bytes
(for example Undo after Complete), a delayed request whose dedupe ran before those commits passes the blob check and
applies a second time (reproduced by the GPT-6 Astra review). The Inbox case-collision check also needs the listing
and the create to refer to one revision.

**Decision.** Every write is a new commit **parented on the pinned commit X** that the attempt deduped and read
against, published by a non-force ref update that GitHub accepts only as a fast-forward from X (real behaviour:
`docs/discovery/github-gitdata-probe-2026-09-25.md`). Any commit after X — desktop sync, our own earlier attempt, an
Undo — makes the update fail (`head-moved`); the executor then re-dedupes against a newer X and re-plans.
GitHub adapter: Git Data API (blob, tree with `base_tree`, commit, `PATCH ref force:false`). Local adapter:
`update-ref <ref> <new> <X>`. In-memory: head equality. The dedupe window is paged completely.

**Consequences.** Exactly-once holds across inverses; the Inbox listing at X is authoritative for the create.
More conflicts under concurrent unrelated commits (each costs one retry); retry budget raised from 3 to 5.
Four API calls per write instead of one. Dangling blobs/trees/commits from failed attempts are harmless.
