# ADR-0029 — Research explainer: a daily Cloudflare job writes plain-language paper notes (increment R, Part 1)

**Status:** accepted (owner decisions 2026-09-28). The owner wants, every morning and independent of the PC, the papers
the research scout picked explained in plain language, saved **as notes in the vault**, made **daily**; research notes
may be read by the chosen AI model (ADR-0018 amendment). First app write that no phone command starts.

## Trigger and input

- A **Cron Trigger** on the existing Worker, daily at 04:30 UTC (06:30 Copenhagen summer / 05:30 winter).
- Input (vault via GitHub, as the Worker already reads it): today's `Research/Reading Briefs/Research Reading Brief -
  YYYY-MM-DD.md` → the links under `## Read today`; if that is empty, the first links under `## Most relevant items` of
  today's `Research/Daily Research Scout/Daily Research Scout - YYYY-MM-DD.md`. At most **5** papers per day, in note
  order. The item's own line (the scout's short "why") travels with it.
- No brief for today yet ⇒ nothing to do (not an error); the job also runs at 06:30 UTC as a catch-up (idempotent).

## Reading the paper (no PDF parsing in the Worker)

Workers Free allows 10 ms CPU per invocation, so the Worker never downloads or parses the paper: it asks the model to
read it **by URL** (Gemini URL-context / file-by-URL capability; arXiv `abs` links are rewritten to their PDF/HTML form).
Model chain: `gemini-3.5-flash-lite` → `gemini-3.1-flash-lite` → `gemini-3.8-flash` (one retry on 503/429, next model
on quota). All fail ⇒ no note for that paper today (retried by the next run), recorded in the status record.
Key: Worker secret `GEMINI_API_KEY` (never logged). Output is requested as JSON (fields below), validated with zod,
then rendered to Markdown by our code — model text is never written unvalidated.

## Output note (write target 1)

`Research/Explained/YYYY-MM-DD - <slug>.md` (slug from the paper title: ASCII, ≤ 80 chars), **create-only**: if the path
exists the paper is skipped. Frontmatter: `type: research-explained`, `created`, `source` (paper URL), `scout_note`
(wikilink to the brief), `model`, `status: complete`. Sections, in order: `## In plain words` (≤ 5 sentences, no jargon),
`## Key ideas` (3–5 bullets, each with a small example), `## Why it may matter to you` (from the scout's own why line +
the paper; no private task data is sent to the model), `## Glossary`, `## Try it` (1–3 small experiments with a time
estimate), `## How solid is it` (limits, evidence), `## Source` (link, authors/venue if given).

## Status record (write target 2)

`Automation/Scout Status/research-explainer.json` in the existing ScoutStatus schema (ADR-0020), so the Scouts page and
Scout insights show its health, last run, findings (= notes written) and errors with no new UI.

## Write mechanics

Same path as every write (ADR-0005/0011): one commit per run containing all new notes plus the status record, parented
on the pinned head (head-CAS), commit trailers, operation ID = a deterministic UUID from `research-explainer:<date>`
(a re-run of the same day dedupes; new notes of a catch-up run get a `:catchup` suffix). Paths allowlist: only
`Research/Explained/*.md` (create) and that one status file (create/update); `canWrite` enforces it.

**Amendment (Lead, 2026-09-28, from the R1 worker's questions):**
- *Multi-file commit.* The store gains one multi-file write (blobs → one tree → one commit → fast-forward on the pinned
  head) in the interface and all three adapters, with golden tests. It is also required by the budget below: one
  commit per file would cost ~5 GitHub calls each. Every path is checked by `canWrite` before any blob is sent.
- *Dedupe without a client base.* The cron job has no client request, so "already ran today" is read from the status
  record, which is written in the same commit as the notes (atomic). The operation ID stays deterministic
  (`research-explainer:<date>`, catch-up `…:catchup`) and goes into the commit trailers. If the ScoutStatus schema has no
  field for it, add an optional one; the Scouts page must keep parsing older records.
- *Subrequest budget.* Workers Free allows 50 subrequests per invocation. One budget constant (≤ 45, leaving margin)
  covers GitHub + Gemini calls. Gemini calls stop when the remaining budget cannot cover them plus the commit. Papers
  that don't fit are recorded as deferred in the status record, and the 06:30 catch-up run takes them first.

## Out of scope (later)

Part 2 "This morning" on Today (digest, explanations, scouts, events, tasks); explanations on demand; promote/"Start
experiment" button (will reuse the existing Active Work add); personalisation with private task data.

**Amendment 2 (owner, 2026-09-28): carry-over and pending notes.**
- *Carry-over.* A paper that is picked but not explained (all models failed, link not readable, or deferred by the
  budget) is kept in the status record as pending (URL, scout's why line, source note, first-seen date). Each run takes
  pending papers first, oldest first, within the same cap of 5 and the same budget, then today's picks. A paper is
  dropped after its **3rd** day.
- *Pending note.* Such a paper still gets its note at once, with `status: pending`: frontmatter as usual (`model` empty),
  `## Source` (link, scout's why) and one line "Explanation pending; retried automatically." The owner always sees
  every picked paper.
- *Replacing a pending note* (the one exception to create-only): allowed only when the note's current blob SHA equals
  the SHA this job recorded for it in the status record (CAS on blob SHA, rule 4) — so a note the owner has edited is
  never overwritten. On the last day without success the note is rewritten once to `status: unavailable` with the
  reason, in the same commit as the status record.
- *Later (not now):* a second model provider/API key as a further fallback, decided after the first weeks of runs.
