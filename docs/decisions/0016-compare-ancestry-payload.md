# ADR-0016 — O7 compare payload reduction

**Status:** accepted (2026-09-26). Lead re-probed on this repository: page 2 kept `status` with 0 files for one-ahead, identical, behind and five-ahead (page 1 of five-ahead carried 32 files).

**Decision.** `isAncestor` requests `compare?per_page=1&page=2`. It consumes only the range's `status`,
which remains present on page 2; changed files occur only on page 1. Preserve one request and all existing
status/error mappings (including 404 → false, 422 → StoreUnavailable). Do not infer ancestry from page contents.

**Evidence.** [GitHub compare documentation](https://docs.github.com/en/rest/commits/commits#compare-two-commits)
documents first-page-only changed files. Public read-only probes of `octocat/Hello-World`, REST version
`2022-11-28`, on 2026-09-26 returned HTTP 200 without a `files` property for all these page-2 requests:

| Base → head (abbreviated immutable SHAs) | status | total_commits | page-2 commits |
|---|---|---|---|
| 7fd1a60 → 7fd1a60 | identical | 0 | 0 |
| 553c207 → 7629413 | ahead | 1 | 0 |
| 553c207 → 7fd1a60 | ahead | 2 | 1 |
| 7fd1a60 → 553c207 | behind | 0 | 0 |

Full SHAs: `553c2077f0edc3d5dc5d17262f6aa498e69d6f8e`, `762941318ee16e59dabbacb1b4049eec22f0d303`,
`7fd1a60b01f91b314f59955a4e4d4e80d8edf11d`. Tests project those response shapes with synthetic content;
diverged/error cases are synthetic extensions. No private repository was queried. Initial PowerShell/curl
probes failed local TLS; Node fetch succeeded (one transient connection timeout was retried).

**Alternatives left unchanged.** [List commits](https://docs.github.com/en/rest/commits/commits#list-commits)
has no changed-file payload, but its documented maximum page size is 100 and it has no compare status or
range total. This does not establish equivalence to the existing 250-commit single-request contract.

- `commitsSince`: retains page 1. Page 2 would drop required commits. Listing history cannot distinguish an
  absent/nonancestor base from one beyond the page; merge history also cannot safely be sliced at a base's
  position to obtain `base..head`. Extra calls or a smaller bound violate this task's constraints. Preserve
  complete ordered trailers, truncation/ancestry refusals, and tree caching used by ADR-0015 budgets.
- `findOperation`: retains paged compare, including first-page patches. Listing would change range membership,
  oldest-first search (including duplicate operation trailers), truncation and call budgets. The detail lookup
  for a found commit needs changed paths and stays unchanged too. ADR-0015 removed this primitive from commands.
- Current task reads use `commitsSince`, not `isAncestor`. This change therefore does **not** fix the measured
  6–13 ms live-read CPU cost. O7 remains open for the hot path; no Free-plan CPU claim follows from this change.

**Verification.** `compare-payload.test.ts` asserts page selection, status/error equivalence and one call;
its synthetic 50-file measurement counts UTF-8 JSON bytes actually passed to response parsing, not compressed
network bytes or CPU. The existing read/write/Undo budget tests remain unchanged. See the branch handoff for
executed checks and measured byte counts. No new REST endpoint or extra request is introduced.
