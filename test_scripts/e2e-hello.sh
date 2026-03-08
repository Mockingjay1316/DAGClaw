#!/usr/bin/env bash
# E2E: Basic hello world — single subtask, full pipeline
# Usage: cd /home/mockingjay/research/claw_ui && bash test/e2e-hello.sh

set -uo pipefail
source ~/.nvm/nvm.sh
unset CLAUDECODE

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
TEST_DIR="$SCRIPT_DIR/workdir-hello"
rm -rf "$TEST_DIR"
mkdir -p "$TEST_DIR"
echo '{"type": "commonjs"}' > "$TEST_DIR/package.json"

echo "=== E2E: Hello World ==="
echo "Working directory: $TEST_DIR"
echo ""

node --import tsx "$PROJECT_DIR/bin/claw.js" \
  --workdir "$TEST_DIR" \
  --backend cli \
  --yolo \
  "Create a simple hello world Node.js program in index.js that prints 'Hello, World!' to the console" \
  2>&1 | tee "$SCRIPT_DIR/e2e-hello.log"

EXIT_CODE=${PIPESTATUS[0]}
echo ""
echo "=== Run complete (exit code: $EXIT_CODE) ==="
echo ""

if [ -f "$TEST_DIR/index.js" ]; then
  echo "=== Generated: index.js ==="
  cat "$TEST_DIR/index.js"
  echo ""
  echo "=== Running ==="
  node "$TEST_DIR/index.js" && echo "(success)" || echo "(failed)"
else
  echo "WARNING: index.js was not created"
fi

echo ""
echo "=== Plan ==="
[ -f "$TEST_DIR/.dagclaw/tmp/plan.json" ] && python3 -m json.tool "$TEST_DIR/.dagclaw/tmp/plan.json" 2>/dev/null || echo "(no plan)"

echo ""
echo "=== Run History ==="
node --import tsx "$PROJECT_DIR/bin/claw.js" --workdir "$TEST_DIR" runs --last 2>&1 || true
