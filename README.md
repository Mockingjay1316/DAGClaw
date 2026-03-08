# DAGClaw

A multi-stage recursive orchestration engine for Claude Code. Decomposes software engineering tasks into subtasks via a **Plan → Execute → Verify** pipeline, running subtasks in parallel via DAG scheduling with automatic retry on verification failure. Includes a CLI for direct terminal use and an Express + WebSocket backend server for remote/programmatic access.

## Quick Start

```bash
# Prerequisites: Node.js >= 19, Claude Code CLI installed

# Install dependencies
npm install

# Run a task (CLI)
node --import tsx bin/dagclaw.js "Add error handling to the auth module"

# With options
node --import tsx bin/dagclaw.js \
  --workdir ./my-project \
  --yolo \
  --max-concurrency 5 \
  "Refactor the database layer"

# View run history
node --import tsx bin/dagclaw.js runs
node --import tsx bin/dagclaw.js runs --last

# Start the backend server
node --import tsx backend/src/index.ts
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
Usage: dagclaw [options] "your task description"

Options:
  --workdir <path>         Working directory (default: current dir)
  --backend cli|sdk        Claude backend (default: cli)
  --pipeline <stages>      Comma-separated stage names (default: Plan,Execute,Verify)
  --dag-stages <stages>    Stages available for DAG subtask assignment (default: Execute)
  --max-concurrency <n>    Max parallel subtasks (default: 3)
  --timeout <seconds>      Per-stage timeout (default: 300)
  --yolo                   Full auto mode: skip plan approval, auto permissions
  --auto-approve           Skip plan approval prompt
  --no-memory              Don't inject .dagclaw/memory/ context
  --no-summary             Skip cost summary

Subcommands:
  dagclaw runs                List all runs
  dagclaw runs --last         Show details of the most recent run
```

## Permission Modes

- **interactive** (default) — Claude Code asks before each tool execution
- **--yolo** — fully automatic, no permission prompts (tools restricted via `--allowedTools`)
- **--auto-approve** — skip plan approval, but Plan stage still interactive

## Project Memory

DAGClaw injects project knowledge from `.dagclaw/memory/*.md` into every Claude instance:

```
.dagclaw/memory/
├── conventions.md    # coding standards, naming patterns
├── patterns.md       # what worked in past runs
└── errors.md         # recurring issues and solutions
```

Create these files manually to guide Claude's planning and execution. Memory is injected into the system prompt of every stage.

## Run Logs

Every run is persisted to `.dagclaw/runs/<run-id>/`:

```
.dagclaw/runs/2026-03-05T18-26-46_7ea06bfd/
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

## Backend Server

The backend wraps the orchestration engine in an Express + WebSocket server, enabling remote task management and real-time status updates.

### Starting the Server

```bash
# Development (no auth, localhost only)
node --import tsx backend/src/index.ts

# With authentication and restricted access
CLAW_API_KEY=your-secret-key \
CLAW_ALLOWED_DIR=/home/user/projects \
CLAW_CORS_ORIGINS=https://your-frontend.example.com \
  node --import tsx backend/src/index.ts
```

### Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | HTTP/WebSocket server port |
| `CLAW_API_KEY` | unset (auth disabled) | API key for HTTP (`Authorization: Bearer <key>`) and WebSocket (first-message auth) |
| `CLAW_ALLOWED_DIR` | `$HOME` | Base directory for workDir validation (blocks path traversal) |
| `CLAW_CORS_ORIGINS` | `http://localhost:5173,http://localhost:3000` | Comma-separated allowed CORS origins |
| `CLAW_MAX_TASKS` | `5` | Maximum concurrent running tasks |
| `CLAW_MAX_WS_CLIENTS` | `100` | Maximum simultaneous WebSocket connections |
| `CLAW_RATE_LIMIT_MAX` | `10` | Max task creation requests per IP per minute |

### API Usage

```bash
# Create a task
curl -X POST http://localhost:3001/api/tasks \
  -H 'Content-Type: application/json' \
  -d '{"prompt": "Add input validation", "workDir": "/home/user/project"}'

# With auth enabled
curl -X POST http://localhost:3001/api/tasks \
  -H 'Authorization: Bearer your-secret-key' \
  -H 'Content-Type: application/json' \
  -d '{"prompt": "Add input validation", "workDir": "/home/user/project"}'

# List tasks
curl http://localhost:3001/api/tasks

# Get task detail
curl http://localhost:3001/api/tasks/<id>

# Approve a pending plan
curl -X POST http://localhost:3001/api/tasks/<id>/approve

# Cancel a task
curl -X DELETE http://localhost:3001/api/tasks/<id>
```

### WebSocket

Connect to `ws://localhost:3001`. If `CLAW_API_KEY` is set, send `{"type":"auth","token":"<key>"}` as the first message within 5 seconds.

Subscribe to task events:
```json
{"type": "subscribe", "nodeIds": ["<task-id>"]}
```

The server pushes real-time events: `stage_start`, `stage_complete`, `subtask_start`, `subtask_complete`, `approval_required`, `node_status`.

## Development

```bash
# Core tests (202 tests)
node --import tsx --test core/__tests__/*.test.ts

# Backend tests (60 tests)
node --import tsx --test backend/__tests__/*.test.ts

# All tests (262 total)
node --import tsx --test core/__tests__/*.test.ts backend/__tests__/*.test.ts

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
core/                          Shared orchestration engine
├── taskOrchestrator.ts        Pipeline driver, DAG scheduling, retry, recursive decomposition
├── claudeRunner.ts            Claude CLI subprocess spawning, output parsing
├── stageDefinitions.ts        Built-in Plan/Execute/Verify stage configs
├── configLoader.ts            Custom stage loading from dagclaw.config.json/.ts
├── promptBuilder.ts           Template interpolation, snapshot formatting
├── dependencyResolver.ts      Topological sort, cycle detection
├── taskManager.ts             Lockfile management, task node factory, TaskRegistry
├── runLogger.ts               Persistent run logging to .dagclaw/runs/
├── memoryManager.ts           .dagclaw/memory/ read/write
└── types.ts                   All interfaces and Zod schemas

cli/                           Terminal interface
├── cli.ts                     CLI entry point, arg parsing, terminal output
└── dagDisplay.ts              Live DAG status display

backend/                       Express + WebSocket server
├── src/
│   ├── index.ts               Server setup, middleware, security headers
│   ├── taskStore.ts           In-memory task lifecycle manager
│   ├── routes/                REST API (tasks, stages)
│   ├── middleware/            Auth, rate limiting
│   └── websocket/             WS server, message buffers, subscriptions
└── __tests__/                 Backend tests (60 tests)
```

See [HUMAN.md](HUMAN.md) for a detailed developer guide, [docs/DATAFLOW.md](docs/DATAFLOW.md) for call graphs and data flow diagrams, and [docs/PLAN.md](docs/PLAN.md) for the full system architecture and roadmap.

## Current Status

**Phase 0–2.5: Core Engine — Complete**

CLI orchestrator with plan decomposition, parallel DAG execution, verification with automatic retry, cascade-skip, persistent logging, memory injection, recursive decomposition, custom stages, per-subtask stage routing, live DAG display, and cost summary. 202 core unit tests.

**Phase 3: Backend Server — Complete**

Express + WebSocket backend with REST API for task/stage management, real-time WebSocket events, and security hardening (API key auth with timing-safe comparison, rate limiting, path traversal prevention, CORS restriction, WebSocket resource limits, body size cap, generic error responses, security headers). 60 backend tests.

**E2E Validation — Continuous**

E2E test scripts in `test_scripts/` cover core flows: dependency resolution, retry logic, cascade-skip, concurrency control, memory injection, recursive decomposition, and natural language planning.

## Roadmap

| Phase | Description | Status |
|-------|-------------|--------|
| **0** | Bootstrap CLI orchestrator | Done |
| **1** | Recursive decomposition (subtasks spawn child pipelines) | Done |
| **2** | Custom stages, pipeline-aware planning, per-subtask stage routing | Done |
| **2.5** | Live DAG display, tree-format cost summary, stage ticker | Done |
| **3** | Express + WebSocket backend server | Done |
| **4** | React frontend with xterm.js terminals | Done |
| **5** | Polish, error handling, responsive UI | Not started |

See [PLAN.md](PLAN.md) for full details on each phase and the future roadmap.

## Tech Stack

- **Runtime**: Node.js + TypeScript (via tsx, no build step)
- **Claude integration**: `claude -p` CLI with `--output-format stream-json`
- **Backend**: Express 5, ws (WebSocket)
- **Validation**: Zod schemas for all structured agent output
- **Testing**: `node:test` built-in runner (262 tests, zero test dependencies)
- **Dependencies**: `tsx`, `zod`, `express`, `cors`, `ws`
