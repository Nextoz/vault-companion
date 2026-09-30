#!/usr/bin/env bash
# Lead wake watcher. Keeps the existing CLI:
#   WATCH_LOGS=<dir> WATCH_HANDOFFS=<clone1,clone2> READY_BACKLOG=<file> HERDR_LEAD_PANE=<pane> \
#     bash tools/wait-for-work.sh [interval-seconds] [max-hours]
# Delegates to tools/worker-watcher.mjs (deduplicated, bounded polling, no vault content reads).
set -u
repo_dir=$(cd "$(dirname "$0")/.." && pwd)
exec node "$repo_dir/tools/worker-watcher.mjs" "$@"