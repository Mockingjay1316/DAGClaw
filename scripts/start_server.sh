#!/usr/bin/env bash
# Start DAGClaw backend + frontend dev server.
# Run from the project root: bash scripts/start_server.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PID_DIR="$PROJECT_DIR/.dagclaw/pids"

mkdir -p "$PID_DIR"

# Source nvm if node isn't on PATH
if ! command -v node &>/dev/null; then
  [ -s "$HOME/.nvm/nvm.sh" ] && source "$HOME/.nvm/nvm.sh"
fi

# Check if already running
if [ -f "$PID_DIR/backend.pid" ] && kill -0 "$(cat "$PID_DIR/backend.pid")" 2>/dev/null; then
  echo "Backend already running (PID $(cat "$PID_DIR/backend.pid"))"
else
  echo "Starting backend on port ${PORT:-3001}..."
  cd "$PROJECT_DIR"
  node --import tsx backend/src/index.ts > "$PID_DIR/backend.log" 2>&1 &
  echo $! > "$PID_DIR/backend.pid"
  echo "Backend started (PID $!)"
fi

if [ -f "$PID_DIR/frontend.pid" ] && kill -0 "$(cat "$PID_DIR/frontend.pid")" 2>/dev/null; then
  echo "Frontend already running (PID $(cat "$PID_DIR/frontend.pid"))"
else
  echo "Starting frontend on port 5173..."
  cd "$PROJECT_DIR/frontend"
  npx vite --host > "$PID_DIR/frontend.log" 2>&1 &
  echo $! > "$PID_DIR/frontend.pid"
  echo "Frontend started (PID $!)"
fi

sleep 2

# Print access info
LAN_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
echo ""
echo "=== DAGClaw is running ==="
echo "  Local:   http://localhost:5173"
if [ -n "$LAN_IP" ]; then
  echo "  LAN:     http://$LAN_IP:5173"
fi
echo "  Backend: http://localhost:${PORT:-3001}"
echo ""
echo "Stop with: bash scripts/stop_server.sh"
