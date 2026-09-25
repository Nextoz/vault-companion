# Brief D2 — scrub personal metadata now that the repo is public

Type: **documentation/test hygiene** (bounded). Branch `agent/public-scrub`. Model: Codex GPT-6 Astra, effort **low**.

Change current files only (history is out of scope). Replace, don't delete meaning:

1. Replace the owner-specific private vault repository identifier with `<owner>/<vault-repo>`
   (a private vault repository) everywhere except `docs/bootstrap/**` (owner-authored; leave untouched).
2. Replace personal-signal examples with neutral synthetic ones such as `Area Example` and `Example notes`.
   Keep structural facts that matter to the design (a `Journal/`, `Health/`, `Finance/` folder exists
   and is excluded by policy).
3. Replace local user-profile path prefixes with `%USERPROFILE%` and standalone local usernames with
   `<user>` in `docs/reviews/**` and `docs/discovery/**`.
4. `git grep -n -i -E '[k]nowledge-vault-private|[e]vkar|[j]ob search|[t]herapy' HEAD -- . ':!docs/bootstrap/**'`
   must return nothing afterwards; run it and paste the result in the commit message. Character classes
   keep this equivalent scan pattern from matching the brief itself.

Must not change code semantics. Tests may change only their example strings; `pnpm lint`, `pnpm typecheck`,
`pnpm test` must stay green. Commit on `agent/public-scrub`. Final line: `D2 DONE <commit-sha>`.
