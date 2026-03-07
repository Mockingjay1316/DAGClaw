#!/usr/bin/env bash
# E2E: DAG display — verify live status output (non-TTY fallback via pipe)
# Tests that DAG events produce structured status lines:
#   - "running" messages for started subtasks
#   - "done" messages for completed subtasks
#   - "Waiting" lines for blocked subtasks
#   - No ANSI codes when piped (non-TTY)
#
# Uses a 3-subtask chain: 0 (independent), 1 depends on 0, 2 depends on 1
# Usage: cd /home/mockingjay/research/claw_ui && bash test_scripts/e2e-dag-display.sh

set -uo pipefail
source ~/.nvm/nvm.sh
unset CLAUDECODE

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
TEST_DIR="$SCRIPT_DIR/workdir-dag-display"
LOG_FILE="$SCRIPT_DIR/e2e-dag-display.log"
rm -rf "$TEST_DIR"
mkdir -p "$TEST_DIR"
echo '{"type": "commonjs"}' > "$TEST_DIR/package.json"

echo "=== E2E: DAG Display (non-TTY) ==="
echo "Working directory: $TEST_DIR"
echo ""

# Pipe stdout to file to test non-TTY fallback (no ANSI codes)
node --import tsx "$PROJECT_DIR/bin/claw.js" \
  --workdir "$TEST_DIR" \
  --backend cli \
  --yolo \
  --max-concurrency 2 \
  "Build a 3-file Node.js chain with strict dependencies:

1. Subtask 0 (no deps): Create base.js — exports: module.exports = { name: 'base' };
2. Subtask 1 (depends on 0): Create middle.js — requires base.js, exports: module.exports = { ...require('./base'), layer: 'middle' };
3. Subtask 2 (depends on 1): Create top.js — requires middle.js, prints JSON.stringify(require('./middle'))

The dependency chain must be: 0 → 1 → 2 (sequential)." \
  > "$LOG_FILE" 2>&1

EXIT_CODE=$?
echo "Run exit code: $EXIT_CODE"
echo ""

echo "=== Full output ==="
cat "$LOG_FILE"
echo ""

echo "=== Key checks ==="
echo ""

# Check for subtask-started events (running messages)
echo "--- Running messages ---"
grep -c 'running' "$LOG_FILE" | xargs -I{} echo "Found {} 'running' messages"
grep 'running' "$LOG_FILE" || echo "FAIL: No running messages found"

# Check for subtask-completed events (done messages)
echo ""
echo "--- Done messages ---"
grep -c 'done' "$LOG_FILE" | xargs -I{} echo "Found {} 'done' messages"
grep 'done' "$LOG_FILE" || echo "FAIL: No done messages found"

# Check for elapsed time in parentheses
echo ""
echo "--- Elapsed time ---"
grep -E '\([0-9]+s\)' "$LOG_FILE" || echo "FAIL: No elapsed time found in output"

# Check for waiting/blocked messages (subtasks 1,2 should be waiting early on)
echo ""
echo "--- Waiting/blocked messages ---"
grep -i 'waiting\|blocked' "$LOG_FILE" || echo "INFO: No waiting messages (may have been consumed by rapid execution)"

# Check for ANSI escape codes (should be NONE in piped output)
echo ""
echo "--- ANSI escape code check (should be absent) ---"
if grep -P '\x1b\[' "$LOG_FILE" > /dev/null 2>&1; then
  echo "FAIL: ANSI escape codes found in piped output"
else
  echo "OK: No ANSI escape codes in piped output (non-TTY fallback works)"
fi

# Verify subtask indices appear in order
echo ""
echo "--- Subtask index ordering ---"
grep -oE '\[Execute\] \[[0-9]+\]' "$LOG_FILE" || grep -oE '\[[0-9]+\].*done' "$LOG_FILE" || echo "INFO: Could not extract subtask ordering"

echo ""
echo "=== Generated files ==="
for f in base.js middle.js top.js; do
  if [ -f "$TEST_DIR/$f" ]; then
    echo "  $f: $(cat "$TEST_DIR/$f" | tr '\n' ' ')"
  else
    echo "  $f: NOT CREATED"
  fi
done

if [ -f "$TEST_DIR/top.js" ]; then
  echo ""
  echo "=== Running top.js ==="
  node "$TEST_DIR/top.js" && echo "(success)" || echo "(failed)"
fi

echo ""
echo "=== Run History ==="
node --import tsx "$PROJECT_DIR/bin/claw.js" --workdir "$TEST_DIR" runs --last 2>&1 || true
