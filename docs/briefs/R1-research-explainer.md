# Brief R1 — Research explainer (Claude Code Cloud, branch agent/explainer)

**Push early:** within the first minutes commit `.agent/handoffs/R1-research-explainer.md` (one-line stub) on branch
`agent/explainer` (from `main`) and push; push at each stable point and at the end. No PR, no sub-agents.

Contract: `docs/decisions/0029-research-explainer.md` (read fully). Follow AGENTS.md (non-negotiables + worker token
economy). Synthetic fixtures only (invented paper titles/links such as `https://arxiv.org/abs/2601.00001`).

## Read first (with `rg -n`, then line windows)
- Worker entry and composition: `apps/worker/src/index.ts`, `apps/worker/src/app.ts`, `apps/worker/wrangler.jsonc`.
- Write path used by commands (head-CAS, trailers, dedupe): `packages/domain/src/commands.ts` (find where a command
  becomes a commit), the GitHub store used by the Worker, `packages/domain/src/paths.ts` (`canWrite`, scout status dir).
- ScoutStatus schema: `packages/contracts/src/index.ts` (`ScoutStatus`); scout pages: `apps/web/src/ui/Scouts.tsx`.

## Build
1. `packages/domain/src/research-explainer.ts` (pure): parse the brief/scout note sections → ≤ 5 `{url, why}` items;
   arXiv URL rewrite; slug; `ExplanationJson` zod schema; `renderExplanation(json, meta) → Markdown` (exact golden test);
   deterministic operation IDs. No framework imports (AGENTS rule 5).
2. `canWrite`: allow `Research/Explained/*.md` (create only; one level, `.md`, no hidden files) and
   `Automation/Scout Status/research-explainer.json` (create/update); tests that siblings and other folders are refused.
3. Worker: `scheduled` handler + `crons` in `wrangler.jsonc` (`30 4 * * *` and `30 6 * * *`); a Gemini client behind
   an interface (model chain, retry rules per ADR, URL-based reading, JSON output, 60 s timeout per call) so tests use a
   fake; one commit per run via the existing write machinery; the status record. `GEMINI_API_KEY` from env; never log it,
   never log paper or model text.
4. Tests (Vitest, fake Gemini + in-memory/real-Git store as other Worker tests do): no brief ⇒ no commit; 3 items ⇒ 3
   notes + status in one commit; existing note skipped; a model 503 then success; all models fail ⇒ status `degraded`
   with the error, no note; invalid model JSON ⇒ that paper skipped; re-run same day ⇒ dedupe (no second commit);
   `canWrite` guards. Each guard mutation-checked (revert → test fails → restore).
5. Docs: add both write targets to `docs/vault-contract.md`; add the secret and cron to `docs/deploy.md`.

Do **not** deploy, set secrets or call the real Gemini API (the Lead does, after review). No e2e/Playwright needed.

## Checks
`pnpm exec vitest run <touched test files> --reporter=dot`, `pnpm -r exec tsc --noEmit`, `pnpm lint`.

## Handoff (≤ 15 lines) in `.agent/handoffs/R1-research-explainer.md`
What you built, test counts, mutation results, anything uncertain (especially the Gemini URL-reading API shape you
used — cite the doc you followed). Last line `R1 DONE` or `R1 BLOCKED: <reason>`.
