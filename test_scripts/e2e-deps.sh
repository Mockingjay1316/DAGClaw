#!/usr/bin/env bash
# E2E: DAG dependency resolution — 3 subtasks with diamond dependency
# Usage: cd /home/mockingjay/research/claw_ui && bash test/e2e-deps.sh

set -uo pipefail
source ~/.nvm/nvm.sh
unset CLAUDECODE

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
TEST_DIR="$SCRIPT_DIR/workdir-deps"
rm -rf "$TEST_DIR"
mkdir -p "$TEST_DIR"
echo '{"type": "commonjs"}' > "$TEST_DIR/package.json"

echo "=== E2E: Dependency Resolution ==="
echo "Working directory: $TEST_DIR"
echo ""

node --import tsx "$PROJECT_DIR/bin/claw.js" \
  --workdir "$TEST_DIR" \
  --backend cli \
  --yolo \
  --max-concurrency 3 \
  "Build a small Node.js project with three files:

1. math.js - exports functions: add(a,b), multiply(a,b)
2. strings.js - exports functions: capitalize(str), reverse(str)
3. main.js - imports both math.js and strings.js, then:
   - prints add(2,3) result
   - prints multiply(4,5) result
   - prints capitalize('hello') result
   - prints reverse('world') result

Each file must be a separate subtask. main.js depends on both math.js and strings.js being created first. Use CommonJS require() syntax. No external dependencies." \
  2>&1 | tee "$SCRIPT_DIR/e2e-deps.log"

EXIT_CODE=${PIPESTATUS[0]}
echo ""
echo "=== Run complete (exit code: $EXIT_CODE) ==="
echo ""

echo "=== Plan ==="
[ -f "$TEST_DIR/.claw/tmp/plan.json" ] && python3 -m json.tool "$TEST_DIR/.claw/tmp/plan.json" 2>/dev/null || echo "(no plan)"

echo ""
echo "=== Verification ==="
[ -f "$TEST_DIR/.claw/tmp/verify.json" ] && python3 -m json.tool "$TEST_DIR/.claw/tmp/verify.json" 2>/dev/null || echo "(no verification)"

echo ""
echo "=== Generated Files ==="
for f in math.js strings.js main.js; do
  if [ -f "$TEST_DIR/$f" ]; then
    echo "--- $f ---"
    cat "$TEST_DIR/$f"
    echo ""
  else
    echo "WARNING: $f not created"
  fi
done

if [ -f "$TEST_DIR/main.js" ]; then
  echo "=== Running main.js ==="
  node "$TEST_DIR/main.js" && echo "(success)" || echo "(failed)"
fi

echo ""
echo "=== Run History ==="
node --import tsx "$PROJECT_DIR/bin/claw.js" --workdir "$TEST_DIR" runs --last 2>&1 || true
