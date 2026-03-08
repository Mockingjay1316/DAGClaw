#!/usr/bin/env bash
# E2E: Stale lock cleanup — leftover lock from dead PID gets cleaned up
# Usage: cd /home/mockingjay/research/claw_ui && bash test/e2e-stale-lock.sh

set -uo pipefail
source ~/.nvm/nvm.sh
unset CLAUDECODE

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
TEST_DIR="$SCRIPT_DIR/workdir-stale-lock"
rm -rf "$TEST_DIR"
mkdir -p "$TEST_DIR"
echo '{"type": "commonjs"}' > "$TEST_DIR/package.json"

# Pre-seed a stale lock at the real path (.dagclaw/lock) with a non-existent PID
mkdir -p "$TEST_DIR/.dagclaw"
cat > "$TEST_DIR/.dagclaw/lock" << 'LOCK'
{"pid": 99999999, "runId": "stale-run-id", "startedAt": "2026-01-01T00:00:00.000Z"}
LOCK

echo "=== E2E: Stale Lock Cleanup ==="
echo "Working directory: $TEST_DIR"
echo ""
echo "Pre-seeded stale lock (.dagclaw/lock):"
cat "$TEST_DIR/.dagclaw/lock"
echo ""
echo "--- Starting claw ---"
echo ""

node --import tsx "$PROJECT_DIR/bin/claw.js" \
  --workdir "$TEST_DIR" \
  --backend cli \
  --yolo \
  "Create a file called hello.js that prints 'Lock test passed'" \
  2>&1 | tee "$SCRIPT_DIR/e2e-stale-lock.log"

EXIT_CODE=${PIPESTATUS[0]}
echo ""
echo "=== Run complete (exit code: $EXIT_CODE) ==="

echo ""
echo "=== Key check: stale lock warning should appear ==="
grep -i "stale\|lock\|cleaned" "$SCRIPT_DIR/e2e-stale-lock.log" || echo "(no stale lock message found)"

echo ""
echo "=== Key check: lock file should be gone after run ==="
[ -f "$TEST_DIR/.dagclaw/lock" ] && echo "FAIL: lock file still exists" || echo "PASS: lock file cleaned up"

echo ""
echo "=== Result ==="
[ -f "$TEST_DIR/hello.js" ] && node "$TEST_DIR/hello.js" || echo "hello.js not created"

echo ""
echo "=== Run History ==="
node --import tsx "$PROJECT_DIR/bin/claw.js" --workdir "$TEST_DIR" runs --last 2>&1 || true
