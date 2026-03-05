#!/usr/bin/env bash
# E2E: Cascading skip — subtask 0 fails, dependents 1 and 2 get auto-skipped
# Usage: cd /home/mockingjay/research/claw_ui && bash test/e2e-cascade-skip.sh

set -uo pipefail
source ~/.nvm/nvm.sh
unset CLAUDECODE

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
TEST_DIR="$SCRIPT_DIR/workdir-cascade-skip"
rm -rf "$TEST_DIR"
mkdir -p "$TEST_DIR"
echo '{"type": "commonjs"}' > "$TEST_DIR/package.json"

# Pre-seed a read-only file that subtask 0 must write to — but can't
mkdir -p "$TEST_DIR/locked"
touch "$TEST_DIR/locked/data.json"
chmod 444 "$TEST_DIR/locked"

echo "=== E2E: Cascading Skip ==="
echo "Working directory: $TEST_DIR"
echo "locked/ is read-only to force subtask 0 to fail"
echo ""

node --import tsx "$PROJECT_DIR/bin/claw.js" \
  --workdir "$TEST_DIR" \
  --backend cli \
  --yolo \
  --max-concurrency 3 \
  "Build a 3-file Node.js pipeline with strict dependencies:

1. Subtask 0: Write a JSON config file to locked/data.json with contents {\"name\": \"test\", \"version\": 1}. The locked/ directory is read-only and cannot be written to — this WILL fail.
2. Subtask 1 (depends on 0): Read locked/data.json and create reader.js that prints the config name. Depends on subtask 0.
3. Subtask 2 (depends on 1): Create main.js that requires reader.js and prints 'Pipeline complete'. Depends on subtask 1.

Each must be a separate subtask with the dependency chain: 0 → 1 → 2." \
  2>&1 | tee "$SCRIPT_DIR/e2e-cascade-skip.log"

EXIT_CODE=${PIPESTATUS[0]}
echo ""
echo "=== Run complete (exit code: $EXIT_CODE) ==="

# Restore permissions for cleanup
chmod 755 "$TEST_DIR/locked" 2>/dev/null

echo ""
echo "=== Plan ==="
[ -f "$TEST_DIR/.claw/tmp/plan.json" ] && python3 -m json.tool "$TEST_DIR/.claw/tmp/plan.json" 2>/dev/null || echo "(no plan)"

echo ""
echo "=== Verification ==="
[ -f "$TEST_DIR/.claw/tmp/verify.json" ] && python3 -m json.tool "$TEST_DIR/.claw/tmp/verify.json" 2>/dev/null || echo "(no verification)"

echo ""
echo "=== Key check: subtasks 1 and 2 should be skipped ==="
grep -E '\[Execute\].*([Ss]kip|cascade)' "$SCRIPT_DIR/e2e-cascade-skip.log" || echo "(no skip messages found in log)"

echo ""
echo "=== Run History ==="
node --import tsx "$PROJECT_DIR/bin/claw.js" --workdir "$TEST_DIR" runs --last 2>&1 || true
