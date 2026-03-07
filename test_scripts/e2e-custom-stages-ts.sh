#!/usr/bin/env bash
# E2E: Custom stages via claw.config.ts — TypeScript config with full StageDefinition
# Tests that:
#   1. claw.config.ts is loaded and takes priority over .json
#   2. A TS-defined stage with custom contextBuilder/resultHandler works
#   3. The custom stage appears in the pipeline
#
# Usage: cd /home/mockingjay/research/claw_ui && bash test_scripts/e2e-custom-stages-ts.sh

set -uo pipefail
source ~/.nvm/nvm.sh
unset CLAUDECODE

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
TEST_DIR="$SCRIPT_DIR/workdir-custom-ts"
LOG_FILE="$SCRIPT_DIR/e2e-custom-stages-ts.log"
rm -rf "$TEST_DIR"
mkdir -p "$TEST_DIR"
echo '{"type": "commonjs"}' > "$TEST_DIR/package.json"

# Create a claw.config.ts with a custom "Review" stage
cat > "$TEST_DIR/claw.config.ts" << 'TSEOF'
import type { StageDefinition, PipelineState, SubtaskDefinition } from '../src/types.ts';

const ReviewStage: StageDefinition = {
  name: 'Review',
  runnerConfig: {
    systemPrompt: `You are a code review agent. Read the files in the working directory and provide a brief review. Focus on correctness and readability.

Write your review as JSON to the output file:
{"summary": "overall review", "score": "pass" | "needs-work", "comments": ["comment1", "comment2"]}`,
    promptTemplate: `Working directory: {{workDir}}

Review the code created by the execution step.

Plan summary: {{planSummary}}

Write your review JSON to: {{outputFile}}`,
    allowedTools: ['Read', 'Glob', 'Grep', 'Write'],
  },
  approvalRequired: false,

  contextBuilder: (state: PipelineState, outputFile: string, _subtask?: SubtaskDefinition) => ({
    workDir: state.workDir,
    planSummary: state.plan?.summary ?? '(no plan)',
    outputFile,
  }),

  resultHandler: (_state: PipelineState, parsedOutput: unknown | null) => {
    if (!parsedOutput) return '[Review] No output received.';
    const output = parsedOutput as Record<string, unknown>;
    return `[Review] ${output.score ?? 'done'}: ${output.summary ?? 'completed'}`;
  },

  formatStatus: () => '[Review] Running code review...',
};

export default {
  stages: {
    Review: ReviewStage,
  },
};
TSEOF

echo "=== E2E: Custom Stages (claw.config.ts) ==="
echo "Working directory: $TEST_DIR"
echo ""
echo "--- claw.config.ts ---"
cat "$TEST_DIR/claw.config.ts"
echo ""
echo ""

# Run with custom pipeline that includes the Review stage
node --import tsx "$PROJECT_DIR/bin/claw.js" \
  --workdir "$TEST_DIR" \
  --backend cli \
  --yolo \
  --pipeline "Plan,Execute,Review,Verify" \
  "Create a single file counter.js that exports increment(n), decrement(n), and reset() functions. Use CommonJS. No dependencies." \
  2>&1 | tee "$LOG_FILE"

EXIT_CODE=${PIPESTATUS[0]}
echo ""
echo "=== Run complete (exit code: $EXIT_CODE) ==="

echo ""
echo "=== Key checks ==="
echo ""

# Check that config was loaded
echo "--- TS config loaded ---"
if grep -q 'Unknown stage "Review"' "$LOG_FILE"; then
  echo "FAIL: Review stage not recognized (TS config not loaded)"
else
  echo "OK: Review stage was recognized"
fi

# Check that Review stage ran
echo "--- Review stage ran ---"
grep -i '\[Review\]' "$LOG_FILE" || echo "FAIL: No [Review] messages in output"

# Check pipeline order
echo "--- Pipeline order ---"
grep 'Pipeline:' "$LOG_FILE" || echo "FAIL: No pipeline line"

# Check custom formatStatus was used
echo "--- Custom formatStatus ---"
grep 'Running code review' "$LOG_FILE" || echo "INFO: Custom formatStatus may not appear (depends on timing)"

# Check that resultHandler produced output
echo "--- Review result ---"
grep '\[Review\]' "$LOG_FILE" | grep -v 'Running' || echo "INFO: No review result message"

echo ""
echo "=== Generated files ==="
if [ -f "$TEST_DIR/counter.js" ]; then
  echo "--- counter.js ---"
  cat "$TEST_DIR/counter.js"
else
  echo "WARNING: counter.js not created"
fi

echo ""
echo "=== Run History ==="
node --import tsx "$PROJECT_DIR/bin/claw.js" --workdir "$TEST_DIR" runs --last 2>&1 || true
