#!/usr/bin/env bash
# E2E: Large DAG — 5 subtasks with mixed deps (diamond + chain)
#   [0] config ─────┐
#   [1] logger ──┐  │
#                ├──┤──> [3] server (depends on 0,1,2)
#   [2] utils ───┘  │
#                    └──> [4] main (depends on 0,3)
#
# Usage: cd /home/mockingjay/research/claw_ui && bash test/e2e-large-dag.sh

set -uo pipefail
source ~/.nvm/nvm.sh
unset CLAUDECODE

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
TEST_DIR="$SCRIPT_DIR/workdir-large-dag"
rm -rf "$TEST_DIR"
mkdir -p "$TEST_DIR"
echo '{"type": "commonjs"}' > "$TEST_DIR/package.json"

echo "=== E2E: Large DAG (5 subtasks, diamond + chain) ==="
echo "Working directory: $TEST_DIR"
echo ""

node --import tsx "$PROJECT_DIR/bin/claw.js" \
  --workdir "$TEST_DIR" \
  --backend cli \
  --yolo \
  --max-concurrency 3 \
  "Build a Node.js project with 5 modules. Each must be a separate subtask:

1. config.js (no deps) — exports { port: 3000, host: 'localhost' }
2. logger.js (no deps) — exports a log(msg) function that prints '[LOG] <msg>'
3. utils.js (no deps) — exports formatUrl(host, port) that returns 'http://<host>:<port>'
4. server.js (depends on config.js, logger.js, utils.js) — requires all three, calls log('Starting'), then exports { url: formatUrl(config.host, config.port) }
5. main.js (depends on config.js, server.js) — requires config and server, prints 'Server at <server.url> on port <config.port>'

Use CommonJS require(). No external dependencies. The dependency graph is:
- 0,1,2 are independent (can run in parallel)
- 3 depends on 0,1,2
- 4 depends on 0,3" \
  2>&1 | tee "$SCRIPT_DIR/e2e-large-dag.log"

EXIT_CODE=${PIPESTATUS[0]}
echo ""
echo "=== Run complete (exit code: $EXIT_CODE) ==="

echo ""
echo "=== Plan ==="
[ -f "$TEST_DIR/.dagclaw/tmp/plan.json" ] && python3 -m json.tool "$TEST_DIR/.dagclaw/tmp/plan.json" 2>/dev/null || echo "(no plan)"

echo ""
echo "=== Execution order ==="
grep -E '\[Execute\]' "$SCRIPT_DIR/e2e-large-dag.log" || echo "(no execute messages)"

echo ""
echo "=== Generated files ==="
for f in config.js logger.js utils.js server.js main.js; do
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
echo "=== Verification ==="
[ -f "$TEST_DIR/.dagclaw/tmp/verify.json" ] && python3 -m json.tool "$TEST_DIR/.dagclaw/tmp/verify.json" 2>/dev/null || echo "(no verification)"

echo ""
echo "=== Run History ==="
node --import tsx "$PROJECT_DIR/bin/claw.js" --workdir "$TEST_DIR" runs --last 2>&1 || true
