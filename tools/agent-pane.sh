#!/usr/bin/env bash
# Run one agent (or any long command) visibly in its own labelled Herdr pane in the "Agents" tab.
# Output streams live in the pane and is copied to <log>; the pane closes itself 60 s after the command ends.
#
#   bash tools/agent-pane.sh <label> <cwd> <log> <command...>
#   e.g. bash tools/agent-pane.sh "astra-high · pr18" C:/Dev/vault-companion-clones/pr18 C:/…/review.log \
#          codex exec -m gpt-6-astra -c model_reasoning_effort=high -c model_reasoning_summary=detailed … - < brief.md
#
# Set AGENT_STDIN=<file> to feed a brief on stdin. Prints the new pane ID. Requires HERDR_ENV=1 (run from inside Herdr).
set -euo pipefail
[ "${HERDR_ENV:-}" = 1 ] || { echo "not inside Herdr" >&2; exit 2; }
label=$1 cwd=$2 log=$3; shift 3
[ $# -gt 0 ] || { echo "usage: agent-pane.sh <label> <cwd> <log> <command...>" >&2; exit 2; }

ws=${HERDR_WORKSPACE_ID:?}
id_of() { grep -o "\"$1\":\"[^\"]*\"" | head -1 | cut -d'"' -f4; }

# Find or create the Agents tab (never focused: the owner's view stays where it is).
tab=$(herdr tab list --workspace "$ws" | tr '{' '\n' | grep '"label":"Agents"' | id_of tab_id || true)
if [ -z "$tab" ]; then
  created=$(herdr tab create --workspace "$ws" --cwd "$cwd" --label Agents --no-focus)
  tab=$(echo "$created" | tr '{' '\n' | grep '"tab_id"' | id_of tab_id)
  pane=$(echo "$created" | tr '{' '\n' | grep '"pane_id"' | id_of pane_id)
else
  # Split the most recently created pane of the tab; alternate direction to keep panes usable.
  last=$(herdr pane list --workspace "$ws" | tr '{' '\n' | grep "\"tab_id\":\"$tab\"" | id_of pane_id | tail -1)
  count=$(herdr pane list --workspace "$ws" | grep -o "\"tab_id\":\"$tab\"" | wc -l)
  dir=right; [ $((count % 2)) -eq 0 ] && dir=down
  pane=$(herdr pane split --pane "$last" --direction "$dir" --cwd "$cwd" --no-focus | tr '{' '\n' | grep '"pane_id"' | id_of pane_id)
fi
herdr pane rename "$pane" "$label" >/dev/null

# The runner lives next to the log; the pane executes it with Git Bash (tee: live output + log, no PowerShell red).
runner="${log%.*}.run.sh"
{
  echo '#!/usr/bin/env bash'
  printf 'cd %q\n' "$cwd"
  printf 'echo %q\n' "── $label ── started $(date '+%H:%M:%S')"
  printf '%q ' "$@"; if [ -n "${AGENT_STDIN:-}" ]; then printf '< %q ' "$AGENT_STDIN"; fi; printf '2>&1 | tee %q\n' "$log"
  echo 'echo; echo "── finished $(date +%H:%M:%S) — pane closes in 60 s ──"; sleep 60'
  printf 'herdr pane close %q\n' "$pane"
} > "$runner"
# The pane shell is PowerShell, where plain 'bash' is WSL: call this Git Bash by absolute path.
gitbash="$(cygpath -w /)bin\bash.exe"  # Git for Windows launcher: sets PATH (tee, sleep)
herdr pane run "$pane" "& '$gitbash' '$(cygpath -m "$runner")'" >/dev/null
echo "$pane"
