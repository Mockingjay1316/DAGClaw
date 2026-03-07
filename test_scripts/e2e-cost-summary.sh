#!/usr/bin/env bash
# E2E: Cost summary — verify the tree-format cost output with per-stage breakdown
# Expected output format:
#   [Cost] Total: ~$X.XX | Tokens: Xk in / Xk out | Duration: Xm Xs
#     |-- [Plan]    $X.XX  (Xk in / Xk out)
#     |-- [Execute] $X.XX  (Xk in / Xk out)  <- N subtasks
#     +-- [Verify]  $X.XX  (Xk in / Xk out)
#
# Usage: cd /home/mockingjay/research/claw_ui && bash test_scripts/e2e-cost-summary.sh

set -uo pipefail
source ~/.nvm/nvm.sh
unset CLAUDECODE

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
TEST_DIR="$SCRIPT_DIR/workdir-cost-summary"
LOG_FILE="$SCRIPT_DIR/e2e-cost-summary.log"
rm -rf "$TEST_DIR"
mkdir -p "$TEST_DIR"
echo '{"type": "commonjs"}' > "$TEST_DIR/package.json"

echo "=== E2E: Cost Summary (tree format) ==="
echo "Working directory: $TEST_DIR"
echo ""

node --import tsx "$PROJECT_DIR/bin/claw.js" \
  --workdir "$TEST_DIR" \
  --backend cli \
  --yolo \
  "Create two independent Node.js files as separate subtasks:
1. greet.js — exports: module.exports = (name) => 'Hello, ' + name;
2. farewell.js — exports: module.exports = (name) => 'Goodbye, ' + name;

Each file is independent. No dependencies." \
  2>&1 | tee "$LOG_FILE"

EXIT_CODE=${PIPESTATUS[0]}
echo ""
echo "=== Run complete (exit code: $EXIT_CODE) ==="

echo ""
echo "=== Key check: cost summary has tree format ==="
echo ""

# Check for the [Cost] total line
echo "--- Total line ---"
grep '\[Cost\] Total:' "$LOG_FILE" || echo "FAIL: No [Cost] Total line found"

# Check for per-stage breakdown with tree prefixes
echo "--- Per-stage breakdown ---"
grep -E '^\s+(\|--|\\+--) \[' "$LOG_FILE" || echo "FAIL: No tree-formatted per-stage lines found"

# Check for Plan stage line
echo "--- Plan stage ---"
grep -E '\[Plan\].*\$' "$LOG_FILE" | grep -v 'Running\|Generated\|Approve' || echo "FAIL: No [Plan] cost line"

# Check for Execute stage with subtask count (in cost breakdown, uses tree prefix)
echo "--- Execute stage with subtask count ---"
grep -E '^\s+(\|--|[+]--) \[Execute\].*subtask' "$LOG_FILE" || echo "FAIL: No [Execute] cost line with subtask count"

# Check for Verify stage line
echo "--- Verify stage ---"
grep -E '\[Verify\].*\$' "$LOG_FILE" | grep -v 'Running\|passed\|Failed' || echo "FAIL: No [Verify] cost line"

# Check that old format is NOT present
echo "--- Old format absent ---"
if grep -qF -- '--- Cost Summary ---' "$LOG_FILE"; then
  echo "FAIL: Old '--- Cost Summary ---' format still present"
else
  echo "OK: Old format not present"
fi

# Check for token formatting (should use "k" suffix for large numbers)
echo "--- Token formatting ---"
grep -E '\[Cost\].*[0-9]+(\.[0-9])?k\s+(in|out)' "$LOG_FILE" || echo "INFO: Tokens may be below 1k (no k suffix expected)"

# Check for duration formatting (Xm Xs or Xs)
echo "--- Duration formatting ---"
grep -E 'Duration: [0-9]+m [0-9]+s|Duration: [0-9]+s' "$LOG_FILE" || echo "FAIL: No formatted duration found"

echo ""
echo "=== Manifest (raw) ==="
MANIFEST=$(find "$TEST_DIR/.claw/runs" -name manifest.json -type f | head -1)
if [ -n "$MANIFEST" ]; then
  python3 -c "
import json, sys
m = json.load(open('$MANIFEST'))
u = m.get('usage', {})
print(f'  Total input:  {u.get(\"totalInputTokens\", 0)}')
print(f'  Total output: {u.get(\"totalOutputTokens\", 0)}')
print(f'  Est cost:     \${u.get(\"estimatedCost\", 0):.4f}')
print(f'  Per-stage:    {list(u.get(\"perStage\", {}).keys())}')
print(f'  Per-subtask:  {list(u.get(\"perSubtask\", {}).keys())}')
print(f'  Duration:     {m.get(\"duration\", \"n/a\")}ms')
" 2>/dev/null || echo "(could not parse manifest)"
else
  echo "(no manifest found)"
fi

echo ""
echo "=== Run History ==="
node --import tsx "$PROJECT_DIR/bin/claw.js" --workdir "$TEST_DIR" runs --last 2>&1 || true
