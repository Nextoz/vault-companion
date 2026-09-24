# ADR-0001 Source of truth and remote write endpoint

Status: Accepted (bootstrap §3.1, 2026-09-24)

**Context.** The vault lives as Markdown in Git; desktop Obsidian is the working copy; an hourly local
worker syncs with `Nextoz/knowledge-vault-private` on GitHub; Google Drive is a backup mirror.

**Decision.** Markdown + Git history are authoritative. GitHub `main` is the app's durable remote write
endpoint; a commit there is a valid save while the desktop is off, and does not imply desktop receipt.
Google Drive is never on the app's read/write path. All app state beyond a device-local pending queue
is disposable.

**Consequences.** The app must prove its own GitHub adapter and both round trips; the UI must only
claim states it has evidence for (`docs/sync.md`). The desktop worker's behaviour (W1–W5) is an
external dependency verified at the canary.
