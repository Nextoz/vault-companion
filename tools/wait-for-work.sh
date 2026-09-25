#!/usr/bin/env bash
# Blocks until there is Lead work: a CodeRabbit review/comment on an open PR newer than the start time,
# or a new agent/* branch on origin. Prints what changed and exits. Run in the background; the exit wakes the Lead.
# Also exits when a Codex log (*-run.log in $WATCH_LOGS) gains a final `VERDICT:` / `<X> DONE` / `<X> BLOCKED` line.
# Usage: WATCH_LOGS=<dir> tools/wait-for-work.sh [interval-seconds] [max-hours]
set -u
interval=${1:-300}
max_hours=${2:-12}
repo=Nextoz/vault-companion
start=$(date -u +%Y-%m-%dT%H:%M:%SZ)
deadline=$(( $(date +%s) + max_hours * 3600 ))
branches() { git ls-remote --heads origin 'agent/*' | awk '{print $2}' | sort; }
known=$(branches)
touch "$0.started" 2>/dev/null || true

while [ "$(date +%s)" -lt "$deadline" ]; do
  sleep "$interval"
  if [ -n "${WATCH_LOGS:-}" ]; then
    for f in "$WATCH_LOGS"/*-run.log; do
      [ -f "$f" ] && [ "$f" -nt "$0.started" ] || continue
      if grep -q -E '^(VERDICT:|[A-Z0-9-]+ DONE|[A-Z0-9-]+ BLOCKED)' "$f"; then echo "CODEX FINISHED: $f"; exit 0; fi
    done
  fi
  now=$(branches)
  new=$(comm -13 <(echo "$known") <(echo "$now"))
  if [ -n "$new" ]; then echo "NEW BRANCH: $new"; exit 0; fi
  for n in $(gh pr list --repo "$repo" --state open --json number --jq '.[].number'); do
    # A finished review: a review object, or a comment edited after $start that is no longer a placeholder/ack.
    f=".[] | select(.user.login==\"coderabbitai[bot]\") | select((.updated_at // .submitted_at) > \"$start\")"
    f="$f | select((.body // \"\") | test(\"Currently processing|Action(s)? performed|Review triggered\") | not) | .id"
    hits=$( { gh api "repos/$repo/issues/$n/comments" --paginate --jq "$f"
              gh api "repos/$repo/pulls/$n/reviews" --paginate --jq "$f"; } 2>/dev/null | head -1)
    if [ -n "$hits" ]; then echo "CODERABBIT ACTIVITY: PR #$n"; exit 0; fi
  done
done
echo "TIMEOUT after ${max_hours}h: nothing new"
