#!/usr/bin/env bash
# E2E: Recursive decomposition — verifies child orchestrators spawn correctly
# Usage: cd /home/mockingjay/research/claw_ui && bash test_scripts/e2e-recursive.sh [--auto]

set -uo pipefail
source ~/.nvm/nvm.sh
unset CLAUDECODE

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
TEST_DIR="$SCRIPT_DIR/workdir-recursive"
rm -rf "$TEST_DIR"
mkdir -p "$TEST_DIR/src"
AUTO_FLAG=""

if [[ "${1:-}" == "--auto" ]]; then
  AUTO_FLAG="--auto-approve"
fi

echo "=== E2E: Recursive Decomposition ==="
echo "Working directory: $TEST_DIR"
echo ""

# Setup: create a minimal project for claw to work on
cat > "$TEST_DIR/src/main.ts" << 'SRCEOF'
export function add(a: number, b: number): number {
  return a + b;
}

export function subtract(a: number, b: number): number {
  return a - b;
}
SRCEOF

cat > "$TEST_DIR/package.json" << 'PKGEOF'
{
  "name": "e2e-test-project",
  "type": "module",
  "scripts": {
    "test": "echo 'no tests yet'"
  }
}
PKGEOF

# Initialize git so claw can track changes
cd "$TEST_DIR"
git init -q
git add -A
git commit -q -m "Initial commit"

echo "--- Step 1: Run claw with a task that should trigger recursive decomposition ---"
echo ""

# This prompt is designed so the planner will mark at least one subtask
# as needsRecursiveDecomposition: true (the "calculator with multiple operations"
# part is complex enough to warrant decomposition).
TASK="Add a calculator module to src/ with the following features:
1. Basic arithmetic (add, subtract, multiply, divide) - simple, just functions
2. A scientific calculator class with trigonometric functions, logarithms, power, and factorial - this is complex and should be broken into sub-steps
3. Unit tests for both modules

The scientific calculator is complex enough that it should be recursively decomposed into sub-tasks."

echo "Task: $TASK"
echo ""

set +e
node --import tsx "$PROJECT_DIR/bin/claw.js" \
  --workdir "$TEST_DIR" \
  --max-depth 2 \
  $AUTO_FLAG \
  "$TASK" 2>&1 | tee "$TEST_DIR/claw-output.log"
CLAW_EXIT=$?
set -e

echo ""
echo "--- Step 2: Verify results ---"
echo ""

# Check exit code
if [ $CLAW_EXIT -eq 0 ]; then
  echo "[PASS] claw exited successfully"
else
  echo "[FAIL] claw exited with code $CLAW_EXIT"
fi

# Check that .claw/runs/ has at least one run
RUNS_DIR="$TEST_DIR/.claw/runs"
if [ -d "$RUNS_DIR" ]; then
  RUN_COUNT=$(ls -1 "$RUNS_DIR" | wc -l)
  echo "[PASS] Found $RUN_COUNT run(s) in $RUNS_DIR"

  # Check for child runs (nested directories)
  CHILD_DIRS=$(find "$RUNS_DIR" -type d -name "children" 2>/dev/null | wc -l)
  if [ "$CHILD_DIRS" -gt 0 ]; then
    echo "[PASS] Found $CHILD_DIRS children directory(ies) — recursive decomposition occurred!"

    # List child run manifests
    echo ""
    echo "Child run structure:"
    find "$RUNS_DIR" -name "manifest.json" -exec echo "  {}" \;
  else
    echo "[INFO] No children directories found — plan may not have triggered recursion"
    echo "       (Check the plan output to see if any subtask had needsRecursiveDecomposition: true)"
  fi
else
  echo "[FAIL] No .claw/runs/ directory found"
fi

# Check git changes
echo ""
echo "--- Git changes ---"
cd "$TEST_DIR"
git --no-pager diff --stat HEAD

echo ""
echo "--- New/modified files ---"
git status --short

# Check that some files were created
NEW_FILES=$(git status --short | wc -l)
if [ "$NEW_FILES" -gt 0 ]; then
  echo ""
  echo "[PASS] $NEW_FILES file(s) created/modified"
else
  echo ""
  echo "[WARN] No files were created or modified"
fi

echo ""
echo "--- Run history ---"
node --import tsx "$PROJECT_DIR/bin/claw.js" --workdir "$TEST_DIR" runs --last 2>/dev/null || true
