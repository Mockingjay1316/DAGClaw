#!/usr/bin/env bash
# E2E: Natural language input — Plan must decompose an open-ended prompt
# into subtasks on its own, without explicit file/task enumeration.
# Usage: cd /home/mockingjay/research/claw_ui && bash test/e2e-natural.sh

set -uo pipefail
source ~/.nvm/nvm.sh
unset CLAUDECODE

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
TEST_DIR="$SCRIPT_DIR/workdir-natural"
rm -rf "$TEST_DIR"
mkdir -p "$TEST_DIR"
echo '{"type": "commonjs"}' > "$TEST_DIR/package.json"

echo "=== E2E: Natural Language Planning ==="
echo "Working directory: $TEST_DIR"
echo ""

node --import tsx "$PROJECT_DIR/bin/claw.js" \
  --workdir "$TEST_DIR" \
  --backend cli \
  --yolo \
  --max-concurrency 3 \
  "Build a CLI tool that converts temperatures between Celsius and Fahrenheit. It should accept a value and a unit from command line arguments, convert it, and print a human-readable result. Include input validation and helpful error messages." \
  2>&1 | tee "$SCRIPT_DIR/e2e-natural.log"

EXIT_CODE=${PIPESTATUS[0]}
echo ""
echo "=== Run complete (exit code: $EXIT_CODE) ==="

# Show plan decomposition
echo ""
echo "=== Plan (subtask decomposition) ==="
if [ -f "$TEST_DIR/.dagclaw/tmp/plan.json" ]; then
  python3 -c "
import json, sys
p = json.load(open('$TEST_DIR/.dagclaw/tmp/plan.json'))
print(f\"Summary: {p['summary']}\")
print(f\"Subtasks: {len(p['subtasks'])}\")
for s in p['subtasks']:
    deps = f' (depends on: {s[\"dependencies\"]})' if s['dependencies'] else ''
    print(f\"  [{s['index']}] {s['description']} [{s['estimatedComplexity']}]{deps}\")
if p.get('qualityFlag'):
    print(f\"Quality flag: {p['qualityFlag']}\")
" 2>/dev/null || cat "$TEST_DIR/.dagclaw/tmp/plan.json"
else
  echo "(no plan)"
fi

# Find the main entry point and test it
echo ""
echo "=== Smoke test ==="
ENTRY=$(find "$TEST_DIR" -maxdepth 1 -name '*.js' ! -name 'package.json' | head -1)
if [ -n "$ENTRY" ]; then
  echo "Entry point: $ENTRY"
  echo ""
  echo "--- Valid conversions ---"
  node "$ENTRY" 100 C 2>&1 && echo "" || echo "(failed)"
  node "$ENTRY" 32 F 2>&1 && echo "" || echo "(failed)"
  node "$ENTRY" 0 C 2>&1 && echo "" || echo "(failed)"
  echo ""
  echo "--- Invalid inputs (should show errors) ---"
  node "$ENTRY" 2>&1 && echo "" || echo "(error as expected)"
  node "$ENTRY" abc C 2>&1 && echo "" || echo "(error as expected)"
  node "$ENTRY" 100 X 2>&1 && echo "" || echo "(error as expected)"
else
  echo "No .js files found — checking all generated files:"
  find "$TEST_DIR" -maxdepth 2 -type f ! -path '*/.dagclaw/*' ! -name 'package.json'
fi

echo ""
echo "=== Verification ==="
[ -f "$TEST_DIR/.dagclaw/tmp/verify.json" ] && python3 -m json.tool "$TEST_DIR/.dagclaw/tmp/verify.json" 2>/dev/null || echo "(no verification)"

echo ""
echo "=== Run History ==="
node --import tsx "$PROJECT_DIR/bin/claw.js" --workdir "$TEST_DIR" runs --last 2>&1 || true
