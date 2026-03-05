#!/usr/bin/env bash
# E2E: Retry logic — pre-seeded broken code, Verify catches, retry fixes
# Usage: cd /home/mockingjay/research/claw_ui && bash test/e2e-retry.sh

set -uo pipefail
source ~/.nvm/nvm.sh
unset CLAUDECODE

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
TEST_DIR="$SCRIPT_DIR/workdir-retry"
rm -rf "$TEST_DIR"
mkdir -p "$TEST_DIR"
echo '{"type": "commonjs"}' > "$TEST_DIR/package.json"

# Pre-seed deliberately broken code
cat > "$TEST_DIR/calc.js" << 'SEED'
// BUG: add returns subtraction, multiply always returns 0
function add(a, b) { return a - b; }
function multiply(a, b) { return 0; }
module.exports = { add, multiply };
SEED

cat > "$TEST_DIR/test.js" << 'SEED'
const { add, multiply } = require('./calc');
const assert = require('assert');
assert.strictEqual(add(2, 3), 5, 'add(2,3) should be 5');
assert.strictEqual(multiply(4, 5), 20, 'multiply(4,5) should be 20');
console.log('All tests passed');
SEED

echo "=== E2E: Retry Logic ==="
echo "Working directory: $TEST_DIR"
echo ""
echo "Pre-seeded broken calc.js:"
cat "$TEST_DIR/calc.js"
echo ""
echo "Pre-seeded test.js:"
cat "$TEST_DIR/test.js"
echo ""
echo "--- Starting claw ---"
echo ""

node --import tsx "$PROJECT_DIR/bin/claw.js" \
  --workdir "$TEST_DIR" \
  --backend cli \
  --yolo \
  "Fix the bugs in calc.js so that all tests in test.js pass.
The add function currently returns subtraction instead of addition.
The multiply function currently returns 0 instead of the product.
Fix both functions. Do NOT modify test.js.
Run 'node test.js' to verify your fix works." \
  2>&1 | tee "$SCRIPT_DIR/e2e-retry.log"

EXIT_CODE=${PIPESTATUS[0]}
echo ""
echo "=== Run complete (exit code: $EXIT_CODE) ==="
echo ""

echo "=== Final calc.js ==="
cat "$TEST_DIR/calc.js"
echo ""

echo "=== Running tests ==="
node "$TEST_DIR/test.js" && echo "(success)" || echo "(failed)"

echo ""
echo "=== Plan ==="
[ -f "$TEST_DIR/.claw/tmp/plan.json" ] && python3 -m json.tool "$TEST_DIR/.claw/tmp/plan.json" 2>/dev/null || echo "(no plan)"

echo ""
echo "=== Verification ==="
[ -f "$TEST_DIR/.claw/tmp/verify.json" ] && python3 -m json.tool "$TEST_DIR/.claw/tmp/verify.json" 2>/dev/null || echo "(no verification)"

echo ""
echo "=== Run History ==="
node --import tsx "$PROJECT_DIR/bin/claw.js" --workdir "$TEST_DIR" runs --last 2>&1 || true
