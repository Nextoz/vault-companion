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
# jq-free JSON field access: js <expression over r = parsed stdin>
js() { node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const r=JSON.parse(d).result;const v=('"$1"');console.log(v??"")})'; }

# Find or create the Agents tab (never focused: the owner's view stays where it is).
tab=$(herdr tab list --workspace "$ws" | js 'r.tabs.find(t=>t.label==="Agents")?.tab_id')
if [ -z "$tab" ]; then
  created=$(herdr tab create --workspace "$ws" --cwd "$cwd" --label Agents --no-focus)
  pane=$(echo "$created" | js 'r.root_pane.pane_id')
else
  # Split the most recently created pane of the tab; alternate direction to keep panes usable.
  panes=$(herdr pane list --workspace "$ws")
  last=$(echo "$panes" | js "r.panes.filter(p=>p.tab_id==='$tab').map(p=>p.pane_id).pop()")
  count=$(echo "$panes" | js "r.panes.filter(p=>p.tab_id==='$tab').length")
  dir=right; [ $((count % 2)) -eq 0 ] && dir=down
  pane=$(herdr pane split --pane "$last" --direction "$dir" --cwd "$cwd" --no-focus | js 'r.pane.pane_id')
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
