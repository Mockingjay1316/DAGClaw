#!/usr/bin/env bash
# E2E: Empty/trivial task — plan produces 0 subtasks, graceful handling
# Usage: cd /home/mockingjay/research/claw_ui && bash test/e2e-empty-task.sh

set -uo pipefail
source ~/.nvm/nvm.sh
unset CLAUDECODE

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
TEST_DIR="$SCRIPT_DIR/workdir-empty-task"
rm -rf "$TEST_DIR"
mkdir -p "$TEST_DIR"

echo "=== E2E: Empty/Trivial Task ==="
echo "Working directory: $TEST_DIR"
echo ""

node --import tsx "$PROJECT_DIR/bin/claw.js" \
  --workdir "$TEST_DIR" \
  --backend cli \
  --yolo \
  "This project is perfect as-is. Do not create, modify, or delete any files. There is nothing to do." \
  2>&1 | tee "$SCRIPT_DIR/e2e-empty-task.log"

EXIT_CODE=${PIPESTATUS[0]}
echo ""
echo "=== Run complete (exit code: $EXIT_CODE) ==="

echo ""
echo "=== Key check: should skip execute or have 0 subtasks ==="
grep -iE "skip|no subtask|0 subtask" "$SCRIPT_DIR/e2e-empty-task.log" || echo "(no skip/empty message)"

echo ""
echo "=== Plan ==="
[ -f "$TEST_DIR/.claw/tmp/plan.json" ] && python3 -m json.tool "$TEST_DIR/.claw/tmp/plan.json" 2>/dev/null || echo "(no plan)"

echo ""
echo "=== Files created (should be none) ==="
find "$TEST_DIR" -maxdepth 1 -type f ! -name '*.json' | head -10 || echo "(none)"

echo ""
echo "=== Run History ==="
node --import tsx "$PROJECT_DIR/bin/claw.js" --workdir "$TEST_DIR" runs --last 2>&1 || true
