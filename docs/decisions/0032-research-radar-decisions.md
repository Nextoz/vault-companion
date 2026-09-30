# ADR-0032 — Research Radar: read model plus append-only Remove/Keep/Undo decisions (RR1)

**Status:** accepted (Lead acceptance contract, 2026-09-30). RR1 is held: it adds a new write target, so it needs an
independent high-risk review and owner-approved deployment before it ships.

## Purpose

Show the owner three deterministically ranked papers from the last seven rolling days, with topic lists and safe
Remove/Keep/Undo actions. Decisions are durable Markdown/Git records, never mutable UI state. Library and `applied.json`
remain desktop-owned.

## Reads

- Only direct `.md` files under `Research/Daily Research Scout/`, `Research/Reading Briefs/`,
  `Research/Important Research Updates/`, and `Research/Explained/`, plus `Research/Radar/Decisions/YYYY-MM.jsonl` and
  `Research/Radar/applied.json`. No client-named path is ever read; only listing output is accepted.
- A paper's identity is the first 20 hex characters of SHA-256 over its canonical HTTP(S) source URL. Canonicalisation
  lower-cases the host but preserves `www.` and the rest of the host exactly, rejects userinfo/control characters,
  removes the fragment, and drops only unambiguous tracking parameters (`utm_*`, `fbclid`, `gclid`, `mc_cid`,
  `mc_eid`). Supported arXiv `http(s)://arxiv.org` / `export.arxiv.org` `abs`/`pdf` forms are folded to
  `https://arxiv.org/abs/<id>` without query parameters while preserving version suffixes and old category IDs;
  encoded controls are rejected before query removal. Other arXiv host/path shapes and
  unsafe schemes are a typed refusal/null identity, never a guess.
- Ranking is `Important active update` > `Reading Brief pick` > numeric Scout score, then the canonical-URL string for
  stability. The window is seven Copenhagen calendar days from the real source date (`created` or filename), not fetch
  time. Inactive, invalid-date, invalid-URL, missing and degraded sources are reported honestly.
- Read action preference is explanation note, then the intake note, then the safe source URL. Note reads use a dedicated
  server-side API that resolves a `paperId` to an allowlisted note at a pinned revision; the client never sends a path.
  Important/Explained badges mark intake and explanation state.
- Decision history is read from at most the current Copenhagen month plus the preceding 24 monthly logs (25 months).
  Older, future or malformed monthly log filenames, more than 5000 lines, listed-but-missing/blob-mismatched logs, invalid UTF-8, malformed
  JSONL, duplicate IDs and invalid Undo targets are a typed unreadable/refused state, never an invented absence.

## Writes

- The app is the sole writer of `Research/Radar/Decisions/YYYY-MM.jsonl`; the desktop is the sole writer of
  `Research/Radar/applied.json` and `Research/Library`.
- Every decision is an exact append-only JSONL line:
  `{"schemaVersion":1,"decisionId","paperId","decision":"remove|keep|undo","undoes":null|<UUID>,"at","card":{"title","source","topic"}}`.
  Existing bytes are preserved; a new line is appended after one newline. `schemaVersion` is 1; `decisionId` is a UUID;
  `paperId` is 20 hex and must hash from `card.source`; `undoes` is present exactly on `undo` and must name an earlier
  non-undo line in the same or immediately previous monthly log, and must name the same `paperId`. The current and
  previous files must already be valid JSONL; malformed, duplicate-ID, duplicate-target or foreign/cross-paper Undo
  logs are refused rather than appended over. The write appends only the current month and never alters the prior file.
- The write reuses the existing operation-ID, base-revision, head-CAS, commit-trailer and dedupe-before-write executor.
  A retry of the same operation writes nothing more; two same-month writers both land; stale base/head re-plans against
  the newer head; a moved blob is never overwritten on a guess.
- Before appending, the writer validates the same bounded 25-month window and refuses any unreadable log; new Undo
  eligibility remains unchanged: the target must be an earlier, still-active, same-paper decision in the same or
  immediately previous Copenhagen month.
- Radar decisions have their own wire command (`ResearchRadarDecide`) and effect
  (`research-radar-decided`), intentionally outside the shared `Command` union so existing exhaustive command UIs do not
  need a Radar branch.

## Replay and Library status

- Removed and kept papers are excluded from the highlights. Undo is a new line that reverses exactly the named earlier,
  same-paper decision in authoritative append order; later decisions survive and history is never rewritten.
- Historical Remove/Keep decisions older than two months continue to exclude resurfacing papers; Undo targeting an
  older decision preserves all later decisions and is refused when its target is already undone.
- Keep stays `Saving to Library pending` until `Research/Radar/applied.json` records a matching decision as `applied`
  (then `Saved to Library`) or `failed` (then `Library save failed`). A missing desktop job remains pending and is never
  claimed as saved. Applied library paths are validated under `Research/Library/`.
- Offline/conflict responses keep the user's intent visible with Retry/Undo; the app never reports durable Library state
  before it exists.

## Out of scope

RR2 desktop persistence/status producer, phone UX polish, Library content creation, and any claim that the desktop job
exists. Deployment is owner-approved after independent review.
