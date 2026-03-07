#!/usr/bin/env bash
# E2E: Custom stages via claw.config.json — adds a "Lint" stage to the pipeline
# Tests that:
#   1. claw.config.json is loaded and custom stages are merged with built-ins
#   2. A custom stage can be included in --pipeline
#   3. The custom stage runs and produces output
#
# Usage: cd /home/mockingjay/research/claw_ui && bash test_scripts/e2e-custom-stages-json.sh

set -uo pipefail
source ~/.nvm/nvm.sh
unset CLAUDECODE

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
TEST_DIR="$SCRIPT_DIR/workdir-custom-json"
LOG_FILE="$SCRIPT_DIR/e2e-custom-stages-json.log"
rm -rf "$TEST_DIR"
mkdir -p "$TEST_DIR"
echo '{"type": "commonjs"}' > "$TEST_DIR/package.json"

# Create a claw.config.json with a custom "Lint" stage
cat > "$TEST_DIR/claw.config.json" << 'CONFIGEOF'
{
  "stages": {
    "Lint": {
      "name": "Lint",
      "runnerConfig": {
        "systemPrompt": "You are a code quality checker. Review the files in the working directory for common issues: missing semicolons, unused variables, inconsistent naming. Report findings.\n\nWrite your result as JSON to the output file:\n{\"summary\": \"description of findings\", \"issues\": [\"issue1\", \"issue2\"]}",
        "promptTemplate": "Working directory: {{workDir}}\n\nReview all JavaScript files for code quality issues.\n\nWrite your lint result as JSON to: {{outputFile}}",
        "allowedTools": ["Read", "Glob", "Grep", "Write"]
      },
      "approvalRequired": false,
      "parallel": false
    }
  }
}
CONFIGEOF

echo "=== E2E: Custom Stages (claw.config.json) ==="
echo "Working directory: $TEST_DIR"
echo ""
echo "--- claw.config.json ---"
cat "$TEST_DIR/claw.config.json"
echo ""
echo ""

# Run with custom pipeline that includes the Lint stage
node --import tsx "$PROJECT_DIR/bin/claw.js" \
  --workdir "$TEST_DIR" \
  --backend cli \
  --yolo \
  --pipeline "Plan,Execute,Lint,Verify" \
  "Create a single file calculator.js that exports add(a,b) and subtract(a,b) functions using CommonJS. No dependencies." \
  2>&1 | tee "$LOG_FILE"

EXIT_CODE=${PIPESTATUS[0]}
echo ""
echo "=== Run complete (exit code: $EXIT_CODE) ==="

echo ""
echo "=== Key checks ==="
echo ""

# Check that config was loaded (no error about unknown stage)
echo "--- Config loaded successfully ---"
if grep -q 'Unknown stage "Lint"' "$LOG_FILE"; then
  echo "FAIL: Lint stage not recognized (config not loaded)"
else
  echo "OK: Lint stage was recognized"
fi

# Check that Lint stage ran
echo "--- Lint stage ran ---"
grep -i '\[Lint\]' "$LOG_FILE" || echo "FAIL: No [Lint] messages in output"

# Check pipeline order includes Lint
echo "--- Pipeline includes Lint ---"
grep 'Pipeline:' "$LOG_FILE" | grep 'Lint' || echo "FAIL: Pipeline line does not mention Lint"

# Check that Plan, Execute, Verify also ran
echo "--- All built-in stages ran ---"
grep '\[Plan\]' "$LOG_FILE" | head -1 || echo "FAIL: Plan did not run"
grep '\[Execute\]' "$LOG_FILE" | head -1 || echo "FAIL: Execute did not run"
grep '\[Verify\]' "$LOG_FILE" | head -1 || echo "FAIL: Verify did not run"

# Check cost summary includes Lint stage
echo "--- Cost summary includes Lint ---"
grep -E '\[Lint\].*\$' "$LOG_FILE" | grep -v 'Running' || echo "INFO: Lint may not appear in cost summary (depends on usage tracking)"

echo ""
echo "=== Generated files ==="
if [ -f "$TEST_DIR/calculator.js" ]; then
  echo "--- calculator.js ---"
  cat "$TEST_DIR/calculator.js"
else
  echo "WARNING: calculator.js not created"
fi

echo ""
echo "=== Plan ==="
[ -f "$TEST_DIR/.claw/tmp/plan.json" ] && python3 -m json.tool "$TEST_DIR/.claw/tmp/plan.json" 2>/dev/null || echo "(no plan)"

echo ""
echo "=== Run History ==="
node --import tsx "$PROJECT_DIR/bin/claw.js" --workdir "$TEST_DIR" runs --last 2>&1 || true
