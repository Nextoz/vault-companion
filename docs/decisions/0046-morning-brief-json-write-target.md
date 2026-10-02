# ADR-0046 — Morning Brief JSON write target

Status: draft (Lead, 2026-10-02) under the owner's MB backlog item; consequential because it adds a new Worker write
target and stores derived health/mood lines in the vault.

## Context
MB1b builds the Morning Brief and MB1c must persist it. The vault is private, but the brief still contains derived
health and mood lines; it must be written safely, idempotently, and readably by the client.

## Decision
- **One file:** exactly `Daily/Morning Digest/Morning Brief - latest.json`. The cron writes nothing else.
- **Schema:** `BriefFile` in `packages/domain` (`schemaVersion: 1`, `date` YYYY-MM-DD Copenhagen, `generatedAt`,
  top-level `source` `"model" | "fallback"`, `unavailable: string[]`, and the brief). The file is re-validated on
  read with `parseBriefFile`; serialisation is deterministic (stable key order, trailing newline).
- **Write machinery:** same as commands/explainer — operation ID derived from `morning-brief:<date>`, base revision,
  CAS on the existing blob SHA, `Vault-Companion-Job: morning-brief`, `Vault-Companion-Op`, and `StoreUnknownOutcome`
  handling. A CAS conflict or unreadable existing file is a typed no-write outcome.
- **Dedupe:** if the existing file already has today's date, the job stops before gathering/model work and logs
  `204 already-written`. The second daily cron and retries never double-commit.
- **Cron/DST:** two UTC triggers, `31 4 * * *` and `31 5 * * *`, cover 06:31 Europe/Copenhagen across DST. The job
  runs only when the local Copenhagen hour is 6; otherwise it logs `204 skipped`. The brief has its own minute (not the explainer's
  `30 4`) so it runs in its own invocation with its own subrequest budget.
- **Missing key:** `SCALEWAY_API_KEY` is an optional Worker secret. When unset, the deterministic fallback brief is
  written with `source: "fallback"`; the job is not skipped.
- **Not a note:** the brief is an app-read JSON artifact, not an Obsidian note. Markdown notes would put model text
  into the owner's editable note graph and invite manual edits; a single JSON blob keeps the contract machine-checked.
- **Privacy:** the file contains derived health/mood lines and selected task text, but no mail bodies or raw metric
  series; the vault remains the private repository and this is one path inside it.

## Alternatives
- Write a Markdown note under `Daily/`: editable prose breaks the parse-on-read contract and mixes app output into
  notes. Rejected.
- A new dated file per day: more paths to allowlist and no simple `latest` read. Rejected.
- Keep the brief only in Worker memory: the owner wants it in the vault for the client to render. Rejected.

## Consequences
`Daily/Morning Digest/Morning Brief - latest.json` becomes a writable JSON path in `paths.ts` and the vault contract.
The owner accepts one derived-health JSON artifact in the private vault. A leaked Scaleway key spends quota but has no
write path of its own; the commit path is fixed by allowlist, CAS and deterministic operation IDs.
