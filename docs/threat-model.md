# Threat model (first release)

Assets: vault plaintext (tasks, notes, journal, health/finance), GitHub write access, owner identity.
Actors: internet attacker, someone with the owner's unlocked phone, malicious Markdown in the vault
(pasted web content), compromised dependency, compromised provider.

| # | Threat | Mitigation | Test/evidence |
|---|---|---|---|
| T1 | Leaked app URL | Access in front of everything; Worker verifies JWT itself | 401 tests: no token, bad sig, wrong aud, expired, wrong email |
| T2 | Stolen unlocked phone | Access session ≤ 24 h; no vault content persisted on device; pending queue only | storage audit test; manual iPhone check |
| T3 | XSS via vault Markdown | raw HTML off + sanitiser + strict CSP; tasks rendered as text | payload corpus test (script, on*, javascript:, svg, data: URLs) |
| T4 | CSRF | JSON-only POST + custom header + Origin allowlist | 403 tests for each missing guard |
| T5 | Path traversal / out-of-scope write | path policy in domain + adapter; write allowlist | traversal corpus test against both layers |
| T6 | GitHub token / App key leak | server-side secrets only; short-lived tokens; single-repo least privilege | grep bundle for secrets in CI; no token in responses |
| T7 | GitHub/Cloudflare compromise | accepted residual risk; Git history + Drive backup allow recovery | documented |
| T8 | Accidental public preview | previews off/Access-protected; deploy gated | deploy checklist |
| T9 | Sensitive logs | allowlisted logger + sentinel test | CI test |
| T10 | Source maps / debug output | not published; prod build check | build test |
| T11 | Stale write overwrites newer vault content | blob CAS + semantic re-evaluation + conflicts | concurrency tests |
| T12 | Stale projection shown as truth | no projection in v1; every read at HEAD with revision | n/a until index exists |
| T13 | Duplicate effect on retry | trailer dedupe before every write | lost-response tests |
| T14 | Queued content sent under another account | accountKey binding | unit + e2e test |
| T15 | Supply chain | lockfile, audit, minimal deps, pinned CI actions by SHA | CI |
| T16 | Private data in fixtures/repo | synthetic fixtures only; review checklist; gitleaks | review gate |
