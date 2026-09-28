#!/usr/bin/env bash
# Headless Gemini CLI worker for a clone: runs .agent/brief.md with a model fallback chain.
# Usage (through agent-pane so the owner can watch it):
#   AGENT_USER_ENV=GEMINI_API_KEY bash tools/agent-pane.sh "gemini · <task>" <clone> <clone>/.agent/run.log \
#     bash tools/gemini-worker.sh <clone>
# Why (2026-09-28): the free tier is per model — gemini-3.8-flash allows only 20 requests/day, Flash-Lite models far
# more — and Flash returned 503 "high demand" at night. Sub-agents (e.g. "generalist") spend extra requests, and
# headless runs cannot approve edits, so the clone gets workspace settings with agents off and runs in yolo mode.
# The clone is a disposable copy of a public repo with a synthetic brief; never point this at the live vault.
set -u
clone=${1:?clone path}
models=${GEMINI_MODELS:-gemini-3.5-flash-lite gemini-3.1-flash-lite gemini-3.8-flash}
[ -n "${GEMINI_API_KEY:-}" ] || { echo "GEMINI_API_KEY missing (launch with AGENT_USER_ENV=GEMINI_API_KEY)"; exit 2; }
[ -f "$clone/.agent/brief.md" ] || { echo "no $clone/.agent/brief.md"; exit 2; }
mkdir -p "$clone/.gemini"
grep -qx ".gemini/" "$clone/.git/info/exclude" 2>/dev/null || echo ".gemini/" >> "$clone/.git/info/exclude"
[ -f "$clone/.gemini/settings.json" ] || printf '%s\n' '{ "experimental": { "enableAgents": false } }' > "$clone/.gemini/settings.json"
cd "$clone" || exit 2
prompt="Read the file .agent/brief.md in the current directory and carry out that task exactly as written."
for model in $models; do
  for attempt in 1 2; do
    echo "== gemini-worker: model=$model attempt=$attempt $(date +%H:%M:%S)"
    out=$(gemini --skip-trust -m "$model" --approval-mode yolo --output-format json -p "$prompt" 2>&1); code=$?
    printf '%s\n' "$out"
    if [ $code -eq 0 ] && ! grep -qE '"code": ?(429|503)|TerminalQuotaError|RESOURCE_EXHAUSTED' <<<"$out"; then
      echo "== gemini-worker: done with $model"; exit 0
    fi
    if grep -qE 'TerminalQuotaError|exhausted your daily quota|free_tier_requests' <<<"$out"; then
      echo "== gemini-worker: daily quota exhausted on $model, next model"; break
    fi
    if grep -qE '"code": ?(429|503)|UNAVAILABLE|high demand|RESOURCE_EXHAUSTED' <<<"$out"; then
      [ $attempt -eq 1 ] && { echo "== gemini-worker: transient $model error, retry in 60 s"; sleep 60; continue; }
      echo "== gemini-worker: $model still unavailable, next model"; break
    fi
    echo "== gemini-worker: $model failed (exit $code), not a capacity error — stopping"; exit $code
  done
done
echo "== gemini-worker: GEMINI UNAVAILABLE on all models — reroute to Codex"; exit 3
