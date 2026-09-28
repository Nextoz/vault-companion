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

## Out of scope (later)

Part 2 "This morning" on Today (digest, explanations, scouts, events, tasks); explanations on demand; promote/"Start
experiment" button (will reuse the existing Active Work add); personalisation with private task data.
