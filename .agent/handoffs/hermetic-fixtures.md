# Hermetic Git fixtures

## Completed

- All Git children in `packages/github/src/git-fixture.ts` now override inherited global config with the platform null device (`NUL` on Windows, `/dev/null` elsewhere) and set `GIT_CONFIG_NOSYSTEM=1`. Existing author/committer values are preserved.
- Added one regression test that injects synthetic global and system config before dynamically importing the fixture, then checks that neither setting is visible through its Git helper. Environment changes and temporary files are cleaned up in `finally`.
- Production stores and repository planning files are unchanged.

## Important discoveries

- Node's `os.devNull` is `\\.\nul` on Windows; this Git installation rejects that path with `Invalid argument`. Plain `NUL` works and is used instead.
- The GitHub package has no `test` script. `pnpm --filter @vault-companion/github test` exits 0 without running tests. Use the root Vitest runner with a package path to actually execute them.
- Dependencies are absent. pnpm installation and commands that trigger installation fail with `ERR_PNPM_STORE_DIR_OPEN_OPERATION_LOCK`: access denied to `C:\Users\evkar\AppData\Local\pnpm-store-operation-locks\all-stores.lock`. A workspace store override, temporary LOCALAPPDATA, and offline/frozen-store mode did not bypass the shared lock. No approval escalation is available.

## Recommend

- Lead should install dependencies where pnpm can access its store lock, then run `pnpm exec vitest run packages/github/src`, `pnpm lint`, and `pnpm typecheck` before committing.
- Keep production stores unchanged; the requested fix is scoped to the fixture.

## Verification

- `pnpm install --frozen-lockfile`: blocked by shared store lock permissions.
- `pnpm --filter @vault-companion/github test`: exit 0, no tests executed (no package test script).
- `pnpm exec vitest run packages/github/src`: blocked by the same installation lock.
- `pnpm lint`: blocked by the same installation lock.
- `pnpm typecheck`: blocked by the same installation lock.
- Direct Node 24 execution on Windows: PASS for injected global/system config isolation, real-Git seed and external commit/push, and preserved author/committer identity. No push-negotiation warning; the expected empty-repository clone warning remains. This smoke check does not replace the required Vitest/lint/typecheck gates.

## Commit

none, Lead commits
