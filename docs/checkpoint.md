# Checkpoint — 2026-09-26 (fresh-lead handoff: app live on the owner's phone)

Resume procedure: `docs/orchestration.md`. Plan: `docs/plan.md`. This file is the handoff; read it first.

## Deployed

- **`main` = `36aeb42`** (PR #17). Worker `vault-companion` **version `5df4f575-cff6-4b66-a28f-5143ba637fd9`**, custom
  domain **`https://app.karpov.dk`** only (`workers_dev`/`preview_urls` off), Workers **Free** (owner decision P1).
- Cloudflare Access (Zero Trust Free, team `summer-lab-11fd`): app "Companion" covers the whole host incl. `/api/*`;
  two owner-only Allow policies (`evgeny@karpov.dk`; `evkar91@gmail.com` = the GitHub login's email). Worker
  `ALLOWED_EMAILS` holds both.
- GitHub App `vault-companion` (ID 5083868, installation 165082516): Contents write + Metadata read, no webhooks,
  installed only on `Nextoz/knowledge-vault-private` (verified via API).

## Verified — owner's report (not independently checkable by the Lead)
- The owner can sign in on the iPhone (GitHub login via Access) and open and use the app.
- How completed tasks look in Obsidian on the desktop.

## Verified — independently by the Lead (2026-09-26)
- Anonymous requests to `/`, `/api/session`, `/api/tasks` → 302 to the Access login; no app content leaks.
- DNS: only `app.karpov.dk` added; website (`karpov.dk` → GitHub Pages) and Email Routing MX/SPF unchanged.
- Live log (`wrangler tail`): `/api/session` 200; `/api/tasks` 200 in 600–780 ms wall, **3–8 ms CPU**.
- **Live writes happened** (owner using the app, 13:59–14:03 local): 5 `CompleteTask` + 2 `UndoCompleteTask`, all 200,
  **7–15 ms CPU**, 3.1–4.4 s wall; 7 commits by `vault-companion[bot]` with `Vault-Companion-Op`/`-Payload` trailers;
  vault `origin/main` = `2915455`. Desktop sync 14:07 `state: current`, local `HEAD` = `2915455` (fast-forward, no
  conflict), To-Do List clean, nothing staged.
- Not independently verified: security headers on authenticated responses (unit/config tests + `_headers` only), Obsidian
  rendering, phone UX targets.

## First-deploy defects found and fixed today
- Production reads failed (503) — root cause: the GitHub store called the global `fetch` as a method of itself; Workers
  reject that ("Illegal invocation"), Node does not. Fixed in PR #17 with a Workers-like regression test. PR #16 added
  allowlisted error diagnostics (`errorClass`, `errorDetail` from fixed adapter phrases only), which found it.
- Access login mismatch: Access admits the login identity's email; the GitHub login yields `evkar91@gmail.com`.

## G3 canary status
The planned canary (pre-agreed exact diff, then approval) was **not run as such**: live writes began through normal
owner use before a formal G3 approval. Evidence above covers phone → GitHub → desktop. **Owner decides** whether this
counts as the G3 canary or a formal one is still wanted. Pre-write backup exists: snapshot 2026-09-26 08:47
(`Second-Brain-2026-09-26_084416.zip`, sha256 logged in the snapshot log).

## Outstanding defects / risks (ranked)
1. **PR #18 unreviewed, not merged** (`agent/free-budget`): ADR-0015 — every write command within Free (one dedupe page,
   3 attempts, worst case ≤ 25 GitHub calls + JWKS), A4 midnight Done-today overlay, PR #15 review F1–F3. Until merged,
   a delayed write can exceed Free's 50 subrequests (Astra A1) — safe failure (503), not data loss.
2. **Write CPU up to 15 ms** observed vs Free's 10 ms cap (outcome `ok` so far). Measure again after #18; optimise
   (review O7: compare responses carry patches) if requests start failing with `exceededCpu`.
3. Review follow-ups not done: O3/O4 (real PWA queue never run against the real server; harness models conflict
   markers, real worker blocks without them), O7, O9–O11 (`docs/reviews/phase-2-review-{opus,astra}.md`).
4. Phone accessibility/latency targets (`docs/plan.md`) untested; record observations privately in `.private/`.

## Repository state
- Clean except ignored build outputs and one locked, ignored, empty cache dir `apps/worker/tmp-probe/.wrangler/`
  (from a local diagnosis; its secrets file was deleted) — delete after a reboot.
- Open PR: **#18**. Remote branches: `agent/free-budget` only.
- Handoff files on the #18 branch: `.agent/handoffs/{free-budget,read-budget}.md` — disposition before merging.

## Active workers
- Cloud session `session_01TLT6gLxkoKtDHSy8CcCpmb` (built P4-B/P4-E/read-budget/free-budget; repo attached, can push):
  **finished**, idle. No other workers running. No Codex runs in flight. Live log (`wrangler tail`) stopped.

## Local files (locations only — never commit or paste contents)
- Deploy secrets: `C:\Users\evkar\.vault-companion-secrets\secrets.json` (9/9 valid); GitHub App key (PKCS#1 original
  and `app-pkcs8.pem`) in the same folder.
- Wrangler login: encrypted token, key in Windows Credential Manager (`wrangler whoami` to check).
- Sync-worker patches and backups: Lead scratchpad `…\scratchpad\syncfix\` (v2 installed in the vault).
- Live-log capture of the first deploy: Lead scratchpad `…\scratchpad\tail.jsonl` (UTF-16) + `readtail.cjs` parser.
  (Scratchpad = `%LOCALAPPDATA%\Temp\claude\C--Dev-vault-companion\7c683c50-bbfe-4fe2-b77a-169d59018365\scratchpad`.)

## Next concrete action
1. Review PR #18 (focused: write budgets, base-revision refresh for never-sent items, F1–F3) → CI → merge → redeploy
   (`cd apps/worker && pnpm exec wrangler deploy --domain "app.karpov.dk"`) → `wrangler tail` a few reads/writes.
2. Ask the owner about G3 (count today's writes as the canary, or run a formal one).
3. Then milestone 3: several days of owner use; next improvements chosen from observed friction.
