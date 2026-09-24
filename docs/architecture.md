# Architecture

## Shape

```text
apps/
  web/        React + Vite PWA. Talks only to /api. Knows nothing about GitHub.
  worker/     Hono HTTP layer: auth, origin checks, validation, maps HTTP ⇄ application services.
              Runs on Cloudflare Workers in production; the same app runs on Node for the
              disposable end-to-end harness.
packages/
  contracts/      Zod schemas + TS types for commands, receipts, errors, read DTOs. Shared by web and worker.
  vault-markdown/ Pure: parse To-Do List, locate tasks, span-splice mutations, note rendering helpers.
                  No I/O, no HTTP, no GitHub.
  domain/         Application services (command handlers, read queries), VaultStore port, time policy,
                  path policy. Depends on vault-markdown and contracts only.
  github/         VaultStore adapters: GitHubContentsStore (fetch-based, GitHub App auth) and
                  LocalGitStore (git CLI against a bare repo; Node only, for disposable integration).
  test-vault/     Synthetic fixture vault + builders. Structure from phase-0 findings; no private text.
```

`vault-index` is **not** created yet: the first release reads one ~16 KB file per request
(`docs/indexing.md`). It is added only when a measured need appears.

## Dependency rule

```
web ──> contracts
worker ──> domain ──> vault-markdown
   │         └──────> contracts
   └──> github ──> domain (implements the VaultStore port)
```

Domain and vault-markdown never import React, Hono, Cloudflare or GitHub types. Enforced by
package `dependencies` and an ESLint `no-restricted-imports` rule.

## VaultStore port

```ts
interface VaultStore {
  head(): Promise<{ commitSha: string }>;
  readFile(path: VaultPath): Promise<{ blobSha: string; bytes: Uint8Array; commitSha: string } | null>;
  // CAS: expectedBlobSha null ⇒ create, fails if exists.
  writeFile(req: { path: VaultPath; expectedBlobSha: string | null; bytes: Uint8Array;
                   message: string; trailers: Record<string, string> })
    : Promise<{ ok: true; commitSha: string; blobSha: string }
            | { ok: false; reason: 'cas-mismatch' | 'exists' }>;
  findOperation(baseCommitSha: string, operationId: string)
    : Promise<{ commitSha: string; payloadHash: string; path: string } | null>;
}
```

Errors other than CAS (network, 5xx, auth) throw a typed `StoreUnavailable`/`StoreUnknownOutcome`;
the command handler treats unknown outcome as "go back to dedupe", never as failure or success.

## Request flow (write)

```
PWA → POST /api/commands (Access JWT cookie/header, X-VC-Request: 1, Origin)
    → worker: authn (Access JWT verify) → origin check → Zod validate
    → domain.execute(command, store, clock, userTz)
        dedupe → read → vault-markdown mutation → CAS write → receipt
    → 200 receipt | 409 conflict | 422 refused | 503 retryable
```

Reads: `GET /api/tasks` → domain.readTasks(store) → parse To-Do List at HEAD →
`{ revision: commitSha, today[], all[], doneToday[] }`, `Cache-Control: no-store`.

## Deliberately absent

Durable Objects, event sourcing, D1 (until justified), vector search, AI, offline vault,
multi-file atomic commits (Git Data API) — each has a trigger condition in `docs/roadmap.md`.

## Decisions

See `docs/decisions/` (ADR-0001 … ADR-0009).
