#!/usr/bin/env bash
# E2E: Memory injection — pre-seed .dagclaw/memory/, verify plan references it
# Usage: cd /home/mockingjay/research/claw_ui && bash test/e2e-memory.sh

set -uo pipefail
source ~/.nvm/nvm.sh
unset CLAUDECODE

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
TEST_DIR="$SCRIPT_DIR/workdir-memory"
rm -rf "$TEST_DIR"
mkdir -p "$TEST_DIR"
echo '{"type": "commonjs"}' > "$TEST_DIR/package.json"

# Pre-seed memory with project conventions
mkdir -p "$TEST_DIR/.dagclaw/memory"
cat > "$TEST_DIR/.dagclaw/memory/conventions.md" << 'MEMORY'
# Project Conventions

- All functions must include a JSDoc comment with @param and @return tags
- Use camelCase for function names
- All modules must export via module.exports (CommonJS)
- Every file must start with a "use strict" directive
MEMORY

cat > "$TEST_DIR/.dagclaw/memory/patterns.md" << 'MEMORY'
# Patterns

- Error handling: always validate input types and throw TypeError for invalid args
- Always include a test at the bottom of each file that runs when executed directly
  (use: if (require.main === module) { ... })
MEMORY

echo "=== E2E: Memory Injection ==="
echo "Working directory: $TEST_DIR"
echo ""
echo "Pre-seeded memory:"
echo "--- conventions.md ---"
cat "$TEST_DIR/.dagclaw/memory/conventions.md"
echo ""
echo "--- patterns.md ---"
cat "$TEST_DIR/.dagclaw/memory/patterns.md"
echo ""
echo "--- Starting claw ---"
echo ""

node --import tsx "$PROJECT_DIR/bin/claw.js" \
  --workdir "$TEST_DIR" \
  --backend cli \
  --yolo \
  "Create a utility module called utils.js with two functions:
1. clamp(value, min, max) - clamps a number between min and max
2. isPrime(n) - returns true if n is prime

Follow all project conventions from memory." \
  2>&1 | tee "$SCRIPT_DIR/e2e-memory.log"

EXIT_CODE=${PIPESTATUS[0]}
echo ""
echo "=== Run complete (exit code: $EXIT_CODE) ==="

echo ""
echo "=== Generated: utils.js ==="
[ -f "$TEST_DIR/utils.js" ] && cat "$TEST_DIR/utils.js" || echo "(not created)"

echo ""
echo "=== Key checks: memory conventions should be reflected ==="
if [ -f "$TEST_DIR/utils.js" ]; then
  echo -n "  'use strict': "
  grep -q "use strict" "$TEST_DIR/utils.js" && echo "PASS" || echo "FAIL"
  echo -n "  JSDoc comments: "
  grep -q "@param" "$TEST_DIR/utils.js" && echo "PASS" || echo "FAIL"
  echo -n "  TypeError validation: "
  grep -q "TypeError" "$TEST_DIR/utils.js" && echo "PASS" || echo "FAIL"
  echo -n "  require.main self-test: "
  grep -q "require.main" "$TEST_DIR/utils.js" && echo "PASS" || echo "FAIL"
  echo ""
  echo "=== Running utils.js (self-test) ==="
  node "$TEST_DIR/utils.js" && echo "(success)" || echo "(failed)"
fi

echo ""
echo "=== Run History ==="
node --import tsx "$PROJECT_DIR/bin/claw.js" --workdir "$TEST_DIR" runs --last 2>&1 || true
