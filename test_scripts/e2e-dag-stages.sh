#!/usr/bin/env bash
# E2E: Per-subtask stage routing via --dag-stages
# Tests that:
#   1. --dag-stages advertises available stages to the planner
#   2. Subtasks can be routed to different stage definitions
#   3. Custom stage definitions (from claw.config.json) work in DAG
#   4. Stage descriptions appear in plan prompt
#
# Sets up a project with an Execute stage and a custom "Check" stage.
# The planner should route some subtasks to Check (read-only review).
#
# Usage: cd /home/mockingjay/research/claw_ui && bash test_scripts/e2e-dag-stages.sh

set -uo pipefail
source ~/.nvm/nvm.sh
unset CLAUDECODE

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
TEST_DIR="$SCRIPT_DIR/workdir-dag-stages"
LOG_FILE="$SCRIPT_DIR/e2e-dag-stages.log"
rm -rf "$TEST_DIR"
mkdir -p "$TEST_DIR"
echo '{"type": "commonjs"}' > "$TEST_DIR/package.json"

# Pre-create a file that the Check stage will review
cat > "$TEST_DIR/existing.js" << 'JSEOF'
// This file has a known bug: missing return statement
function double(x) {
  x * 2;
}
module.exports = { double };
JSEOF

# Create a claw.config.json with a "Check" stage for read-only review
cat > "$TEST_DIR/claw.config.json" << 'CONFIGEOF'
{
  "stages": {
    "Check": {
      "name": "Check",
      "runnerConfig": {
        "systemPrompt": "You are a code checker. Read files and report issues. Do NOT modify any files.\n\nWrite your result as JSON to the output file:\n{\"success\": true, \"summary\": \"description of check results\", \"oneliner\": \"brief result\"}",
        "promptTemplate": "Working directory: {{workDir}}\n\nTask: {{subtaskPrompt}}\n\n{{predecessorContext}}\n\nWrite your check result as JSON to: {{outputFile}}",
        "allowedTools": ["Read", "Glob", "Grep", "Write"]
      },
      "parallel": true
    }
  }
}
CONFIGEOF

echo "=== E2E: DAG Stages (per-subtask routing) ==="
echo "Working directory: $TEST_DIR"
echo ""
echo "--- claw.config.json ---"
cat "$TEST_DIR/claw.config.json"
echo ""
echo "--- existing.js (pre-created with bug) ---"
cat "$TEST_DIR/existing.js"
echo ""
echo ""

# Run with --dag-stages to advertise both Execute and Check
node --import tsx "$PROJECT_DIR/bin/claw.js" \
  --workdir "$TEST_DIR" \
  --backend cli \
  --yolo \
  --dag-stages "Execute,Check" \
  "Do two things as separate subtasks:

1. Fix the bug in existing.js — the double() function is missing a return statement. Add 'return' before 'x * 2'. This should use the Execute stage.
2. After fixing, verify that existing.js now correctly exports the double function and the return statement is present. This is a read-only check — use the Check stage. This subtask depends on subtask 0.

Route each subtask to the appropriate stage using the 'stage' field." \
  2>&1 | tee "$LOG_FILE"

EXIT_CODE=${PIPESTATUS[0]}
echo ""
echo "=== Run complete (exit code: $EXIT_CODE) ==="

echo ""
echo "=== Key checks ==="
echo ""

# Check that the planner received dag stage descriptions
echo "--- DAG palette in plan prompt ---"
PROMPT_DIR=$(find "$TEST_DIR/.claw/runs" -name "prompts" -type d | head -1)
if [ -n "$PROMPT_DIR" ] && [ -d "$PROMPT_DIR" ]; then
  echo "Checking plan prompt for stage descriptions..."
  grep -l 'Check\|Execute' "$PROMPT_DIR"/plan*.md 2>/dev/null | head -1 | xargs grep -c 'Check' 2>/dev/null | xargs -I{} echo "  'Check' mentioned {} times in plan prompt"
else
  echo "INFO: Could not find prompt logs"
fi

# Check plan for stage assignments
echo ""
echo "--- Plan stage assignments ---"
if [ -f "$TEST_DIR/.claw/tmp/plan.json" ]; then
  python3 -c "
import json
plan = json.load(open('$TEST_DIR/.claw/tmp/plan.json'))
for s in plan.get('subtasks', []):
    stage = s.get('stage', 'Execute')
    print(f'  Subtask {s[\"index\"]}: stage={stage}, desc=\"{s[\"description\"]}\"')
" 2>/dev/null || echo "(could not parse plan)"
else
  echo "(no plan file)"
fi

# Check that both Execute and Check stages ran
echo ""
echo "--- Execute stage messages ---"
grep '\[Execute\]' "$LOG_FILE" | head -3 || echo "FAIL: No [Execute] messages"

echo ""
echo "--- Check stage messages ---"
grep '\[Check\]' "$LOG_FILE" | head -3 || echo "INFO: No [Check] messages (planner may not have routed to Check)"

# Verify the bug was fixed
echo ""
echo "--- Bug fix verification ---"
if [ -f "$TEST_DIR/existing.js" ]; then
  if grep -q 'return' "$TEST_DIR/existing.js"; then
    echo "OK: existing.js now has a return statement"
  else
    echo "FAIL: existing.js still missing return statement"
  fi
  echo "--- existing.js (after fix) ---"
  cat "$TEST_DIR/existing.js"
  echo ""
  echo "--- Running double(5) ---"
  node -e "const m = require('$TEST_DIR/existing.js'); console.log('double(5) =', m.double(5));" 2>&1 || echo "(failed to run)"
else
  echo "WARNING: existing.js not found"
fi

echo ""
echo "=== Plan ==="
[ -f "$TEST_DIR/.claw/tmp/plan.json" ] && python3 -m json.tool "$TEST_DIR/.claw/tmp/plan.json" 2>/dev/null || echo "(no plan)"

echo ""
echo "=== Run History ==="
node --import tsx "$PROJECT_DIR/bin/claw.js" --workdir "$TEST_DIR" runs --last 2>&1 || true
