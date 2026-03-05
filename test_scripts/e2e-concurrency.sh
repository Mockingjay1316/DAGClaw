#!/usr/bin/env bash
# E2E: Concurrency limit — 4 independent subtasks with --max-concurrency 1
# Verifies they run one at a time (sequential ordering in output)
# Usage: cd /home/mockingjay/research/claw_ui && bash test/e2e-concurrency.sh

set -uo pipefail
source ~/.nvm/nvm.sh
unset CLAUDECODE

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
TEST_DIR="$SCRIPT_DIR/workdir-concurrency"
rm -rf "$TEST_DIR"
mkdir -p "$TEST_DIR"
echo '{"type": "commonjs"}' > "$TEST_DIR/package.json"

echo "=== E2E: Concurrency Limit (max-concurrency=1) ==="
echo "Working directory: $TEST_DIR"
echo ""

node --import tsx "$PROJECT_DIR/bin/claw.js" \
  --workdir "$TEST_DIR" \
  --backend cli \
  --yolo \
  --max-concurrency 1 \
  "Create 4 independent Node.js files, each as a separate subtask with NO dependencies between them:

1. one.js — exports: module.exports = 1;
2. two.js — exports: module.exports = 2;
3. three.js — exports: module.exports = 3;
4. four.js — exports: module.exports = 4;

Each file is completely independent. No file depends on any other." \
  2>&1 | tee "$SCRIPT_DIR/e2e-concurrency.log"

EXIT_CODE=${PIPESTATUS[0]}
echo ""
echo "=== Run complete (exit code: $EXIT_CODE) ==="

echo ""
echo "=== Execution order (should be strictly sequential with concurrency 1) ==="
grep -E '\[Execute\] \[' "$SCRIPT_DIR/e2e-concurrency.log" || echo "(no execute messages)"

echo ""
echo "=== Key check: only 1 'Running' at a time ==="
echo "Running messages should alternate with Done messages (no two Running in a row):"
grep -E '\[Execute\].*Running|\[Execute\].*Done' "$SCRIPT_DIR/e2e-concurrency.log" || true

echo ""
echo "=== Generated files ==="
for f in one.js two.js three.js four.js; do
  if [ -f "$TEST_DIR/$f" ]; then
    echo "  $f: $(cat "$TEST_DIR/$f" | tr '\n' ' ')"
  else
    echo "  $f: NOT CREATED"
  fi
done

echo ""
echo "=== Run History ==="
node --import tsx "$PROJECT_DIR/bin/claw.js" --workdir "$TEST_DIR" runs --last 2>&1 || true
