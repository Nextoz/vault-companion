# ADR-0059: Morning Brief schema v2 foundation

Status: Accepted (owner MB3 / slice MB3a)

## Context
The app brief is becoming the shared source for the emailed digest and app sheet.
Calendar failure must not look like a free day, and real meetings must survive model failure.
Markdown + Git remain authoritative; this decision changes the existing JSON projection only.

## Decision
- Write schemaVersion 2. Parse v1 and v2 into the v2 shape; upgrade v1 with empty meetings and unavailableReasons.
- Default omitted v2 meetings/reasons to empty values. Preserve source consistency validation and deterministic serialization.
- Store sorted calendar meetings with title, start, end, allDay, clash, optional clashWith and link.
- Timed intervals clash only for positive overlap; touching endpoints and all-day events never clash.
- clashWith joins the other overlapping titles in start order with a semicolon separator.
- Accept only HTTPS calendar.google.com links or www.google.com/calendar/ links; drop other links.
- Persist per-reader unavailableReasons using fixed ApiError codes or threw; reason names must occur in unavailable.
- Rank up to five todo candidates; use the same cap and candidate-id validation in the writer.
- Attach overdueDays only for dates before the brief day, using whole calendar days (UTC date arithmetic).
- Calendar titles are deterministic output from the reader, never model input. This is a new privacy boundary.
- The model receives calendar count, first start, clash count, unavailable names/codes and derived free blocks only.
- Compute the day line deterministically for both model and fallback output: meeting count and first start.
- Failed Calendar yields “Calendar unavailable (<code>)” and no free blocks or gap suggestions.
- Busy days never get an “open day” day line. Meeting explanations are outside this slice.
- Preserve existing operation IDs, CAS, commit trailers, dedupe and subrequest budget; add no reader calls.
- Extend the mirrored API response fields without changing missing/stale-date behavior.
- Web sheet and email rendering changes belong to MB3a-2.

## Consequences
Meeting facts and failure reasons remain available without model output; models cannot invent calendar summaries.
Existing v1 files remain readable; new files have stable v2 bytes.
Synthetic fixtures cover links, clashes, failures, prompt privacy and overdue dates; logs contain no titles or task text.

## Amendment (MB3b): digest sections
- Additive, optional schemaVersion 2 fields on `brief`: `news[]` and `research[]` (`{title, line, url}`, https-only,
  at most three each) and `oneThing {text, quote?}`. v1/v2 files without them still parse unchanged.
- The tracked PC digest note (`Daily/Morning Digest/Morning Digest - <Copenhagen date>.md`) is read through the existing
  vault read path with an injected reader and parsed by a pure, tolerant domain parser: malformed bullets are skipped,
  non-https links dropped, and every field capped (title 200, line 300, url 500, text/quote 500). It never throws.
- A missing note (`not-found`) or a note with no digest heading (`invalid`) adds reader `digest` to
  `unavailable`/`unavailableReasons`; the News and AI-and-research sections then show
  "<Section> unavailable: <plain reason>". Digest text is never sent to the model; the writer passes the parsed fields
  through unchanged. The sheet collapses News and AI and research by default; the email renders every section in full.

## Amendment (MB3b-2): Needs-you and Copenhagen-today sections
- Additive, optional schemaVersion 2 fields on `brief`: `needsYou[]` (`{title, line, url}`, https-only, at most five)
  and `copenhagen[]` (same shape, https-only, at most three). v1/v2 and MB3b-1 files without them still parse unchanged.
- The same tracked note also carries `## Needs you` (mail links) and `## Copenhagen today` (calendar or other https
  links); the parser recognizes those headings with the identical bullet rule, dropping non-https links and skipping
  malformed bullets. A missing note still reports the single `digest` unavailable reason, which covers every section;
  a parsed note with an empty or absent section simply omits that field. Digest text is never sent to the model.
- The sheet shows Needs you and Copenhagen today as always-visible lists of tappable https rows (44 px target, no
  default underline) between the to-dos and the still-collapsed News/AI-and-research sections; the email renders the
  same rows through the shared presentation helpers. Needs you does not replace the `Jev/*` label to-dos from the Gmail
  reader; both remain. No new read/write target is added, and no title or line is logged.
