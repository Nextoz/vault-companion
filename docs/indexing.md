# Indexing / read model

## First release: no persistent index

Every read parses `Tasks/To-Do List.md` at GitHub HEAD (one Contents API call, ~16 KB, one parse).
The response carries the `commitSha`/`blobSha` it was derived from, so the client always knows
the revision it is looking at. Nothing to go stale, nothing to rebuild. Done today is derived from
`✅` dates in the same file.

Conditional reads: the adapter may cache `{blobSha, content}` in Worker memory per isolate and use
`If-None-Match` on the Contents API; this is an optimisation with no correctness role.

## Triggers for introducing a projection (D1)

Introduce `packages/vault-index` only when one of these is measured: task reads span many files
(Areas/Projects/Quick Find), p95 read latency on phone > 800 ms, or GitHub rate limits are approached.

## Rules that will apply when it exists

Fully rebuildable from Git; every row carries `source_commit_sha`/`source_blob_sha`; index HEAD vs Git
HEAD reported to the client as `current|stale`; writes always validate against Git, never the index;
journal/health/finance bodies are not indexed (metadata only); webhooks are an optimisation, periodic
reconciliation is the guarantee.
