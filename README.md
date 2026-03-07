# Claw UI

A multi-stage recursive orchestration engine for Claude Code. Decomposes software engineering tasks into subtasks via a **Plan → Execute → Verify** pipeline, running subtasks in parallel via DAG scheduling with automatic retry on verification failure.

## Quick Start

```bash
# Prerequisites: Node.js >= 19, Claude Code CLI installed

# Install dependencies
npm install

# Run a task
node --import tsx bin/claw.js "Add error handling to the auth module"

# With options
node --import tsx bin/claw.js \
  --workdir ./my-project \
  --yolo \
  --max-concurrency 5 \
  "Refactor the database layer"

# View run history
node --import tsx bin/claw.js runs
node --import tsx bin/claw.js runs --last
```

## How It Works

```
  You: "Build a REST API with user authentication"
                        │
                        ▼
                   ┌──────────┐     Analyzes codebase, knows available stages
                   │   Plan   │  →  Decomposes into subtasks with dependency graph
                   └────┬─────┘     Assigns stage per subtask (Execute, Lint, custom...)
                        │
                        ▼
   ┌──────────────────────────────────────────────────┐
   │              Heterogeneous DAG                   │
   │                                                  │
   │  [0] Write auth ──→ Execute    ─┐                │
   │  [1] Write tests ──→ Execute    ├→ [3] Lint ──→  │
   │  [2] Add routes ──→ Execute    ─┘    (Lint)      │
   │                                                  │
   │  Runs in parallel (respecting deps)              │
   │  Each subtask gets its own Claude Code instance  │
   │  Complex subtasks recurse into child pipelines   │
   └────────────────────┬─────────────────────────────┘
                        ▼
                   ┌──────────┐     Mandatory post-stage: reviews all changes,
                   │  Verify  │  →  runs tests, re-executes on failure (up to 3 retries)
                   └──────────┘
```

1. **Plan** — A read-only Claude instance analyzes the codebase and produces a structured plan. It knows the available stages (via `--dag-stages`) and assigns each subtask to the appropriate stage. Complex subtasks are marked for recursive decomposition.
2. **DAG Execution** — Subtasks run as independent Claude Code instances in parallel via DAG scheduling. Each subtask routes to its assigned stage definition (Execute, Lint, custom). Subtasks marked `needsRecursiveDecomposition: true` spawn child orchestrators with their own Plan → Execute → Verify pipeline, up to `maxDepth` levels deep (default: 3).
3. **Post-stages** — Mandatory stages after the DAG (e.g., Verify). A verification agent reviews all changes, runs tests, and checks integration. Failed subtasks are automatically re-executed and re-verified.

## CLI Options

```
Usage: claw [options] "your task description"

Options:
  --workdir <path>         Working directory (default: current dir)
  --backend cli|sdk        Claude backend (default: cli)
  --pipeline <stages>      Comma-separated stage names (default: Plan,Execute,Verify)
  --dag-stages <stages>    Stages available for DAG subtask assignment (default: Execute)
  --max-concurrency <n>    Max parallel subtasks (default: 3)
  --timeout <seconds>      Per-stage timeout (default: 300)
  --yolo                   Full auto mode: skip plan approval, auto permissions
  --auto-approve           Skip plan approval prompt
  --no-memory              Don't inject .claw/memory/ context
  --no-summary             Skip cost summary

Subcommands:
  claw runs                List all runs
  claw runs --last         Show details of the most recent run
```

## Permission Modes

- **interactive** (default) — Claude Code asks before each tool execution
- **--yolo** — fully automatic, no permission prompts (tools restricted via `--allowedTools`)
- **--auto-approve** — skip plan approval, but Plan stage still interactive

## Project Memory

Claw injects project knowledge from `.claw/memory/*.md` into every Claude instance:

```
.claw/memory/
├── conventions.md    # coding standards, naming patterns
├── patterns.md       # what worked in past runs
└── errors.md         # recurring issues and solutions
```

Create these files manually to guide Claude's planning and execution. Memory is injected into the system prompt of every stage.

## Run Logs

Every run is persisted to `.claw/runs/<run-id>/`:

```
.claw/runs/2026-03-05T18-26-46_7ea06bfd/
├── manifest.json          # run metadata, status, timing, cost
├── plan.json              # structured plan output
├── tmp/                   # run-scoped structured output (persisted)
│   ├── plan.json
│   └── subtask-0-summary.json
├── prompts/               # exact prompts sent to Claude (for debugging)
│   ├── plan.md
│   ├── execute-subtask-0.md
│   ├── verify.md
│   └── verify-retry-1.md  # retry attempts numbered
├── verification.json      # latest verification result
├── verification-0.json    # first attempt preserved
├── verification-1.json    # retry preserved
├── plan.log               # raw Claude output
├── verify.log
├── subtasks/
│   ├── 0.log              # raw output per subtask
│   └── 1.log
└── children/              # recursive child runs (if any)
    └── <child-run-id>/    # full run structure nested here
```

## Development

```bash
# Run unit tests (241 tests, zero deps test runner)
node --import tsx --test src/__tests__/*.test.ts

# Type check
npx tsc --noEmit

# E2E tests (require Claude Code CLI)
bash test_scripts/e2e-hello.sh        # basic single subtask
bash test_scripts/e2e-deps.sh         # DAG dependency resolution
bash test_scripts/e2e-retry.sh        # verify + retry loop
bash test_scripts/e2e-cascade-skip.sh # failure cascade-skip
bash test_scripts/e2e-concurrency.sh  # concurrency limit
bash test_scripts/e2e-memory.sh       # memory injection
bash test_scripts/e2e-natural.sh      # open-ended natural language
bash test_scripts/e2e-stale-lock.sh   # stale lock cleanup
bash test_scripts/e2e-empty-task.sh   # zero subtasks
bash test_scripts/e2e-large-dag.sh    # 5-subtask complex DAG
bash test_scripts/e2e-recursive.sh    # recursive decomposition
bash test_scripts/e2e-cost-summary.sh # tree-format cost summary
bash test_scripts/e2e-dag-display.sh  # live DAG status display
bash test_scripts/e2e-custom-stages-json.sh # custom stage via config JSON
bash test_scripts/e2e-custom-stages-ts.sh   # custom stage via config TS
bash test_scripts/e2e-dag-stages.sh   # per-subtask stage routing
```

## Architecture

```
src/
├── cli.ts                 CLI entry point, arg parsing, terminal output
├── taskOrchestrator.ts    Pipeline driver, DAG scheduling, retry loop, recursive decomposition
├── dagDisplay.ts          Live DAG status display (TTY in-place updates, non-TTY fallback)
├── claudeRunner.ts        Claude CLI subprocess spawning, output parsing
├── stageDefinitions.ts    Built-in Plan/Execute/Verify stage configs
├── configLoader.ts        Custom stage loading from claw.config.json/.ts
├── promptBuilder.ts       Template interpolation, snapshot formatting
├── dependencyResolver.ts  Topological sort, cycle detection
├── taskManager.ts         Lockfile management, task node factory, TaskRegistry
├── runLogger.ts           Persistent run logging to .claw/runs/
├── memoryManager.ts       .claw/memory/ read/write
└── types.ts               All interfaces and Zod schemas
```

See [HUMAN.md](HUMAN.md) for a detailed developer guide, [DATAFLOW.md](DATAFLOW.md) for call graphs and data flow diagrams, and [PLAN.md](PLAN.md) for the full system architecture and roadmap.

## Current Status

**Phase 0: Bootstrap CLI — Complete**

All 10 source modules implemented. The CLI orchestrator runs end-to-end: plan decomposition, parallel DAG execution, verification with automatic retry, cascade-skip on failure, persistent logging, and memory injection.

**Phase 1: Recursive Decomposition — Complete**

Subtasks with `needsRecursiveDecomposition: true` spawn child orchestrators with their own Plan → Execute → Verify pipelines. `TaskRegistry` tracks parent/child relationships. Run logs nest under the parent run directory.

**Phase 2: Custom Stages & Pipeline-Aware Planning — Complete**

Custom stages via `claw.config.json`/`.ts`. Per-subtask stage routing in the DAG — the planner can assign different stages (Execute, Lint, Verify, custom) to different subtasks. System prompt interpolation enables injecting pipeline metadata (DAG palette, post-stages) into the planner. `--dag-stages` CLI flag controls which stages the planner can use.

**Phase 2.5: Live DAG Display & Cost Summary — Complete**

Live terminal status display during execution: completed tasks lock at top, running tasks show live elapsed time (updated every 500ms), blocked tasks show their unmet dependencies. TTY mode uses ANSI in-place overwriting; non-TTY falls back to sequential log lines. Tree-format cost summary with per-stage breakdown. Standalone stage ticker for Plan/Verify. 241 unit tests passing.

**E2E Validation — Continuous**

E2E test scripts in `test_scripts/` cover core flows: dependency resolution, retry logic, cascade-skip, concurrency control, memory injection, recursive decomposition, and natural language planning.

## Roadmap

| Phase | Description | Status |
|-------|-------------|--------|
| **0** | Bootstrap CLI orchestrator | Done |
| **1** | Recursive decomposition (subtasks spawn child pipelines) | Done |
| **2** | Custom stages, pipeline-aware planning, per-subtask stage routing | Done |
| **2.5** | Live DAG display, tree-format cost summary, stage ticker | Done |
| **3** | Express + WebSocket backend server | Not started |
| **4** | React frontend with xterm.js terminals | Not started |
| **5** | Polish, error handling, responsive UI | Not started |

See [PLAN.md](PLAN.md) for full details on each phase and the future roadmap.

## Tech Stack

- **Runtime**: Node.js + TypeScript (via tsx, no build step)
- **Claude integration**: `claude -p` CLI with `--output-format stream-json`
- **Validation**: Zod schemas for all structured agent output
- **Testing**: `node:test` built-in runner (zero dependencies)
- **Dependencies**: `tsx`, `zod` (that's it)
