# Brief D2 — scrub personal metadata now that the repo is public

Type: **documentation/test hygiene** (bounded). Branch `agent/public-scrub`. Model: Codex GPT-6 Astra, effort **low**.

Change current files only (history is out of scope). Replace, don't delete meaning:

1. `Nextoz/knowledge-vault-private` → `<owner>/<vault-repo>` (a private vault repository) everywhere except
   `docs/bootstrap/**` (owner-authored; leave untouched).
2. Personal-signal examples → neutral synthetic ones: e.g. `Job Search 2026` → `Area Example`, `Therapy notes` →
   `Example notes`. Keep structural facts that matter to the design (a `Journal/`, `Health/`, `Finance/` folder exists
   and is excluded by policy).
3. Local user paths `C:\Users\evkar\...` and `evkar` → `%USERPROFILE%\...` / `<user>` in `docs/reviews/**` and
   `docs/discovery/**`.
4. `git grep -n -i -E 'knowledge-vault-private|evkar|job search|therapy'` over HEAD (excluding `docs/bootstrap/**`)
   must return nothing afterwards; run it and paste the result in the commit message.

Must not change code semantics. Tests may change only their example strings; `pnpm lint`, `pnpm typecheck`,
`pnpm test` must stay green. Commit on `agent/public-scrub`. Final line: `D2 DONE <commit-sha>`.
