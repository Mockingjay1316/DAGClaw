#!/usr/bin/env bash
# Stop DAGClaw backend + frontend dev server.
# Run from the project root: bash scripts/stop_server.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PID_DIR="$PROJECT_DIR/.dagclaw/pids"

stopped=0

for service in backend frontend; do
  pid_file="$PID_DIR/$service.pid"
  if [ -f "$pid_file" ]; then
    pid=$(cat "$pid_file")
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null && echo "Stopped $service (PID $pid)" || echo "Failed to stop $service (PID $pid)"
      stopped=1
    else
      echo "$service not running (stale PID $pid)"
    fi
    rm -f "$pid_file"
  else
    echo "$service not running (no PID file)"
  fi
done

if [ "$stopped" -eq 0 ]; then
  echo "Nothing was running."
fi
