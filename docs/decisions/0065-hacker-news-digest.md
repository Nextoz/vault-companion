# ADR-0065: Hacker News from the shared Morning Digest

Status: Proposed in the Hacker News PR (owner request, 2026-10-15).

## Decision

The owner wants the top three fresh Hacker News best stories, across all topics, in the Morning Digest and Today.
The desktop producer owns selection and deduplication. Its dated Markdown note adds `## Hacker News` with up to
three ordinary digest bullets linking to the HN discussion. Each line contains the score and comment count;
it is not an inferred article summary. Selection follows the official best feed, excludes stories older than
48 hours and previously delivered stories, and uses bounded requests. No HN article or comment text is fetched.

The app adds optional `hackerNews` (at most three digest items) and `hackerNewsUnavailable` to the existing v2 brief.
The pure note parser recognizes the new heading, caps text, accepts only HTTPS HN discussion links, and decodes
the producer's Markdown escapes for plain-text display. `Source unavailable.` marks a failed source;
`Nothing new here today.` produces an empty array. Missing headings/fields preserve older notes and v1/v2 files.
HN content bypasses the model, like the existing digest sections.

Today -> Morning Brief gains a collapsed Hacker News section, separate from News and AI and research.
The existing shared presentation path also supplies the brief email when the digest was available at generation.

## Timing

The desktop digest may arrive after the cloud brief has been committed for the day. On reading the brief, the
app therefore overlays only HN from the exact same day's tracked digest note at the same pinned Git revision.
It reuses the existing directory listing, validates the listed blob SHA, and makes at most one additional file
read. A failed overlay read marks HN unavailable without failing the brief. Other early digest sections retain
their original status. A missing matching note retains any already-saved HN snapshot; yesterday is never used.
The overlay changes neither the saved brief nor its generation time, invokes no model, and sends no extra email.

## Boundaries and rollout

No new external service, secret, write target, schedule, or permission is introduced. No HN or private note text
is logged. The producer change lives in the private vault PR; this repository contains synthetic test data only.
The producer can land first: older app versions ignore the extra heading. This app can land first: older notes
remain readable. Live appearance requires the producer to run and its note to synchronize, plus app deployment.
Opening these PRs does not deploy them or send a digest.

## Verification

Tests cover note -> file -> API -> shared presentation -> email, the actual gather/job path with model and
fallback, a digest arriving after the saved brief, wrong-date isolation, source failure, empty and legacy data,
unsafe links, Markdown/HTML escaping, and phone-width collapsed/open states with three tappable links.
