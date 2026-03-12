# DAGClaw — Developer Guide

A reading guide for programmers maintaining this codebase.

## What This Project Does

DAGClaw is an orchestration engine that decomposes software engineering tasks into subtasks and runs them through a **Plan → Execute → Verify** pipeline using Claude Code as the backend. It has two interfaces: a CLI for direct terminal use, and an Express + WebSocket backend server for remote/programmatic access. It handles parallel execution via DAG scheduling, automatic retries on verification failure, recursive decomposition of complex subtasks, and persistent logging of every run.

## Source Files at a Glance

```
core/                          Shared orchestration engine
├── taskOrchestrator.ts        The engine. Drives stages, schedules DAGs, handles retries.
├── claudeRunner.ts            Spawns `claude -p` subprocesses, parses output, tracks cost.
├── stageDefinitions.ts        Stage configs: Plan, Execute, Verify. All stage-specific logic lives here.
├── configLoader.ts            Custom stage loading from dagclaw.config.json/.ts, merging with builtins.
├── promptBuilder.ts           Template interpolation and snapshot formatting.
├── dependencyResolver.ts      Topological sort for the subtask DAG.
├── taskManager.ts             Lockfile management and task node factory.
├── runLogger.ts               Writes manifests, logs, prompts, and verification results to disk.
├── memoryManager.ts           Reads/writes .dagclaw/memory/ markdown files. readSummaries() for retrieval.
├── memoryDistiller.ts         Post-run distillation: Claude summarizes run → structured memory file.
└── types.ts                   All interfaces, Zod schemas, and type definitions.

cli/                           Terminal interface
├── cli.ts                     Entry point. Parses args, wires up orchestrator, prints output.
└── dagDisplay.ts              Live DAG status display. TTY/non-TTY rendering, stage ticker.

backend/                       Express + WebSocket server
├── src/
│   ├── index.ts               Server entry point. Express app, CORS, auth, security headers.
│   ├── taskStore.ts           In-memory task lifecycle manager. Wraps TaskOrchestrator.
│   ├── routes/
│   │   ├── tasks.ts           REST endpoints: create, list, get, approve, reject, cancel, usage.
│   │   ├── runs.ts            REST endpoints: list run summaries, get full manifest.
│   │   └── stages.ts          REST endpoints: CRUD for custom stage definitions.
│   ├── middleware/
│   │   ├── auth.ts            API key authentication (timing-safe comparison).
│   │   └── rateLimit.ts       Per-IP sliding window rate limiter.
│   └── websocket/
│       ├── wsServer.ts        WebSocket server. Auth, subscriptions, broadcasting.
│       ├── messageBuffer.ts   Per-node ring buffer (1000 messages).
│       └── subscriptionManager.ts  Bidirectional client-to-node subscription tracking.
└── __tests__/                 Backend test suite (66 tests).
```

## Core Concepts

### PipelineState

A mutable object that flows through every stage. Each stage reads what it needs and writes its output here:

- `plan` — set by Plan stage, read by Execute and Verify
- `subtaskSnapshots` — set by Execute (one per subtask), read by Verify
- `verification` — set by Verify, read by the retry loop
- `memoryContext` — loaded once at the start from `.dagclaw/memory/`
- `skippedIndices` — accumulated by the DAG runner when subtasks fail
- `dagPalette` — stages available for DAG subtask assignment (from `--dag-stages`)
- `postStages` — mandatory stages after DAG (derived from pipeline)
- `stageDescriptions` — formatted palette descriptions injected into Plan system prompt

### StageDefinition

The key abstraction. Every stage (Plan, Execute, Verify) is defined as a config object with callback functions. The orchestrator never has stage-specific code — it reads these configs and acts generically:

- `contextBuilder` — maps PipelineState → template variables
- `resultHandler` — receives validated output (parsed by orchestrator via `outputSchema`), updates PipelineState, returns display message
- `subtaskExtractor` — (parallel stages only) extracts subtask list from state
- `resultInterpreter` — (verify stages) returns pass/fail + failed indices
- `retryStage` — name of stage to re-run for failed subtasks

### Structured Output via Files

Agents don't return structured data through stdout. Instead:
1. The prompt tells the agent to write JSON to a run-scoped tmp path (e.g., `.dagclaw/runs/<runId>/tmp/plan.json`)
2. The agent uses the Write tool to create that file
3. The orchestrator's `runOne()` reads and validates the file via the stage's declared `outputSchema` (Zod)
4. The validated result is passed to `resultHandler` — stages never do their own file I/O

Each orchestrator instance (parent and child) gets its own tmp directory, preventing collisions during recursive runs. Output files are persisted inside the run directory.

### Recursive Decomposition

When the Plan stage marks a subtask with `needsRecursiveDecomposition: true`, the DAG runner spawns a child `TaskOrchestrator` instead of calling `runOne()`:
1. `shouldRecurse(index, plan)` checks the flag on the plan subtask
2. `buildChildOptions(parentOpts, subtask, depth)` creates `CliOptions` for the child (auto-approve, same workDir, depth + 1)
3. A child `TaskOrchestrator` runs its own Plan → Execute → Verify pipeline
4. The child uses a nested `RunLogger` (logs go under `parent/children/childRunId/`)
5. The child skips lock management (parent holds the lock)
6. Depth is limited by `maxDepth` (default: 3)

## Module-by-Module Guide

### `types.ts` — The Type Foundation

Read this first. Everything else depends on it.

**Zod schemas** (runtime validation for agent output):
- `PlanSchema` — validates plan JSON: summary, subtasks array, quality flag
- `ExecutorOutputSchema` — validates executor JSON: success boolean, summary, oneliner
- `VerificationResultSchema` — validates verify JSON: overall pass, per-subtask results, integration result

**Key interfaces:**
- `PipelineState` — mutable state passed through the pipeline
- `StageDefinition` — config for a single stage (the core abstraction)
- `CliOptions` — everything parsed from command-line args
- `RunManifest` — persistent run metadata written to disk
- `ContextSnapshot` — summary of what a subtask produced (for downstream context)

### `cli/cli.ts` — CLI Entry Point

Small file. Four responsibilities:
1. `parseArgs()` — converts argv into `CliOptions` (including `--dag-stages`)
2. `handleRuns()` — `claw runs` subcommand, reads run history from disk
3. `main()` — loads custom stages via `loadAndMergeStages()`, validates pipeline against registry, creates `TaskOrchestrator`, calls `run()`
4. Terminal I/O callbacks (`onStatus`, `onWarning`, `onApprovalRequest`, `onDAGEvent`, `onStageStart`, `onStageEnd`)
5. `DagDisplay` wiring — routes DAG events to live terminal display, uses `dagAwareLog` to coordinate stdout writes

### `cli/dagDisplay.ts` — Live Terminal Status

Renders DAG execution progress in the terminal. Two modes:

- **TTY**: ANSI in-place overwriting. Completed/failed/skipped lines are printed permanently above a "mutable zone" of running tasks + blocked waiting line. Timer ticks elapsed time every 500ms.
- **Non-TTY**: Sequential log lines on state changes. Running lines reprinted only when the displayed second changes.

Key methods:
- `handleEvent(DAGEvent)` — processes dag-start, subtask-started/completed/failed/skipped, dag-complete
- `writeStatus(line)` — external status lines interleaved without breaking mutable zone
- `stageStart(label)` / `stageEnd()` — standalone stage ticker (Plan, Verify, custom)
- `isActive()` — true during DAG or stage ticker (used by `dagAwareLog` in cli.ts)
- `finalize()` — clears timers, prints any remaining entries permanently

Internal rendering pattern: track `mutableLineCount`, erase with cursor-up + clear-line, rewrite. `printedIndices` Set prevents duplicate permanent lines.

### `core/taskOrchestrator.ts` — The Engine

The most complex file. Has one class (`TaskOrchestrator`) and several utility functions.

**`run()`** — the main entry point:
1. Checks for stale locks, acquires a new lock
2. Initializes a run (creates manifest on disk)
3. Builds initial PipelineState with memory context
4. Loops through each stage in the pipeline
5. After each stage: handles approval, checks verification results
6. Cleans up: updates manifest status, releases lock

**`runOne(stage, state, subtask?)`** — the single execution primitive:
- Builds the prompt from stage config + pipeline state
- Interpolates both `systemPrompt` and `promptTemplate` with `{{key}}` placeholders from `contextBuilder`
- Logs the prompt to disk (for debugging)
- Spawns Claude via `runClaudeCli()`
- Logs usage and raw output
- Validates output file via `stage.outputSchema` (Zod) if declared
- Passes validated data to `stage.resultHandler()` to update state

Every Claude invocation goes through `runOne`. There are no other paths.

**`runDAG(stage, state, subtasks)`** — parallel execution:
- Creates a `DependencyResolver` from the subtask list
- Greedy scheduler: `tryLaunch()` fills slots up to `maxConcurrency`, each completed task triggers `tryLaunch()` again via `.finally()`. `Promise.race` waits for any completion — no batching.
- **Per-subtask stage routing**: if `subtask.stage` is set, resolves the stage definition from the registry; otherwise falls back to the parent stage (Execute)
- **Per-subtask retry**: `executeSubtask()` wraps each invocation with retry logic (`maxSubtaskRetries`, default 1). Retries on `ClaudeRunError` (transient) or `SubtaskError` with `retryWorthy: true`.
- If `shouldRecurse(index, plan)` is true, calls `runRecursive()` instead of `runOne()`
- On failure: `markSkipped()` cascades to all downstream dependents and returns the cascaded indices

**`runRecursive(runId, stage, state, subtask)`** — recursive decomposition:
- Creates child `CliOptions` via `buildChildOptions()` (auto-approve, noSummary, depth + 1)
- Creates a nested `RunLogger` via `logger.createChildLogger(runId)`
- Spawns a child `TaskOrchestrator` with its own Plan → Execute → Verify pipeline
- On success: stores a `ContextSnapshot` for downstream subtasks
- On failure: throws, triggering cascade-skip in the parent DAG

**`retryLoop(stage, state)`** — verification retry:
- Checks `resultInterpreter` for pass/fail
- If failed: looks up `retryStage` from stage config, re-runs failed subtasks, re-verifies
- Repeats up to `maxRetries` times
- All retry results are numbered and preserved on disk

**Utility functions** (pure, exported for testing):
- `aggregateUsage()` — sums token counts
- `formatTokenCount(n)` — formats token counts ("18.2k" for large, raw number for small)
- `formatDuration(ms)` — formats milliseconds ("3m 24s" or "45s")
- `isGitRepo()`, `getFilesModifiedByGit()` — git helpers
- `shouldRecurse(index, plan)` — checks `needsRecursiveDecomposition` flag
- `buildChildOptions(parentOpts, subtask, depth)` — creates child `CliOptions`

### `core/claudeRunner.ts` — Claude CLI Backend

Pure functions + one async executor. No class.

**`runClaudeCli(options)`** — the core:
- Spawns `claude -p --verbose --output-format stream-json`
- Passes the prompt via stdin
- Collects stdout, parses the last `result` JSON line for usage stats and session ID
- Returns `{rawOutput, sessionId, usage}`

**`buildStagePrompt(template, context)`** — delegates to `interpolateTemplate()`. Replaces `{{key}}` placeholders.

**`parseStageOutput(schema, raw)`** / **`parseStageOutputFile(schema, path)`** — validates JSON against a Zod schema. Returns `null` on failure (with stderr logging). Called by the orchestrator's `runOne()` using the stage's declared `outputSchema`.

**`estimateCost()`** / **`parseUsageFromCliOutput()`** — token counting and cost estimation using Sonnet 4 pricing.

### `core/stageDefinitions.ts` — Stage Configs

All stage-specific logic lives here. The orchestrator imports `getStageDefinition(name, registry?)` and treats every stage identically.

**Plan stage:**
- System prompt: read-only analysis, decompose into subtasks, evaluate prompt quality. Contains `{{dagPaletteDescriptions}}` and `{{postStagesDescription}}` placeholders interpolated at runtime.
- Allowed tools: Read, Glob, Grep, Write (Write for the output file only)
- `contextBuilder`: maps state → {workDir, prompt, memoryContext, outputFile, dagPaletteDescriptions, postStagesDescription}
- `resultHandler`: receives validated Plan, validates stage references against `state.dagPalette`, rejects `needsRecursiveDecomposition` on non-Execute stages, runs cycle detection + shared resource conflict warnings, sets `state.plan`
- `approvalRequired: true` (unless --auto-approve)
- `approvalFormatter`: pretty-prints the plan for user review

**Execute stage:**
- System prompt: full tool access, complete the subtask, write summary JSON
- `parallel: true` — uses DAG scheduling
- `subtaskExtractor`: pulls subtask list from `state.plan`, forwards `stage` field
- `contextBuilder`: includes plan summary, predecessor subtask summaries (wired via `subtask.dependencies` → `state.subtaskSnapshots`), memory
- `resultHandler`: receives validated executor output, throws on `success: false` (triggers cascade-skip), otherwise stores ContextSnapshot

**Verify stage:**
- System prompt: review code, run tests, check each subtask
- `contextBuilder`: includes plan summary, all subtask summaries, skipped indices
- `resultHandler`: receives validated verification result, sets `state.verification`
- `resultInterpreter`: extracts failed indices where `retryRecommended: true`
- `retryStage: "Execute"` — on failure, re-run Execute for failed subtasks
- `maxRetries: 2`

**Helper: `formatStageDescriptions(stageNames, registry?)`** — formats stage names + first line of system prompt + tools for injection into the planner's system prompt.

### `core/configLoader.ts` — Custom Stage Loading

Loads custom stages from `dagclaw.config.ts` (dynamic import, priority) or `dagclaw.config.json` (Zod-validated fallback). Merges with `BUILTIN_STAGES` via `mergeStages()`. Reserved names (Plan, Execute, Verify) require `overrideBuiltin: true`.

- `loadCustomStages(projectDir)` — discovers and loads config file
- `mergeStages(builtins, custom)` — merges with reserved name protection
- `loadAndMergeStages(projectDir)` — convenience: load + merge
- `validateStageDefinition(obj)` — validates required fields for TS-sourced stages
- JSON stages get default `contextBuilder` and `resultHandler` via `makeDefaultContextBuilder()` / `makeDefaultResultHandler()`

### `core/promptBuilder.ts` — Prompt Assembly

- `interpolateTemplate(template, context)` — simple `{{key}}` replacement. Used by `claudeRunner.buildStagePrompt()` for both system prompts and prompt templates.

### `core/dependencyResolver.ts` — DAG Scheduler

- `DependencyResolver` class: tracks pending/complete/skipped state per subtask index
  - `getReady()` — returns indices whose dependencies are all complete
  - `markComplete(index)` — marks done
  - `markSkipped(index)` — marks failed, cascades to all downstream dependents, returns cascaded indices
- `detectCircularDependencies()` — DFS cycle detection, returns the cycle or null
- `getDownstreamDependents(index, entries)` — BFS to find all transitively dependent indices (used by cascade-skip)
- `getUpstreamAncestors(index, entries)` — BFS to find all transitive ancestor indices (for ancestor context injection)

### `core/taskManager.ts` — Lock, Task Factory & Registry

**Lockfile management (production):**
- `acquireLock(workDir, runId)` — atomically creates `.dagclaw/lock` with PID via `wx` flag. Throws if another instance is running. Handles stale locks (dead PID) with atomic re-acquire.
- `releaseLock(workDir)` — removes the lock file
- `checkStaleLock(workDir)` — detects lock from a dead process (checks `process.kill(pid, 0)`), cleans up

**Task tracking (test-only, reserved for future multi-run):**
- `createTaskNode(options)` — factory for TaskNode objects
- `ensureWorkDir(workDir)` — creates work directory if needed
- `TaskRegistry` — tracks parent/child relationships:
  - `register(node)` / `getNode(id)` — store and retrieve by ID
  - `addChild(parentId, childNode)` — links parent and child
  - `getChildren(id)` / `getDescendants(id)` — direct children vs BFS all descendants
  - `getDepth(id)` — walks parentId chain (root = 0)
  - `checkDepthLimit(parentId, maxDepth)` — guard against infinite recursion

**Future direction**: Multi-run support via git worktrees. Each run gets an isolated worktree (`git worktree add .dagclaw/worktrees/<runId>`), eliminating file-level conflicts. `TaskRegistry` would be repurposed as a `RunRegistry` to track active runs, their worktrees, and status. Lock scope would shift from per-project to per-worktree.

### `core/runLogger.ts` — Persistent Logging

Writes everything to `.dagclaw/runs/<runId>/`:

- `initRun()` — creates directory structure + initial manifest, sets `currentRunId` for run-scoped tmp
- `writePlan()` — saves plan JSON
- `appendSubtaskLog()` — streaming output per subtask (appends)
- `appendStageLog()` — raw output for Plan/Verify, numbered by attempt
- `logStagePrompt()` — saves full prompt + system prompt as markdown
- `writeVerification()` — numbered per attempt (verification-0.json, verification-1.json)
- `updateSubtaskUsage()` / `updateStageUsage()` — updates manifest with token counts
- `recalcTotals()` (private) — sums perStage + perSubtask into totals, called by updateSubtaskUsage/updateStageUsage
- `listRuns()` — reads all manifests, returns sorted summaries
- `createChildLogger(parentRunId)` — creates a nested logger for child runs (logs go under `parent/children/childRunId/`)
- `cleanTmp()` / `tmpPath()` — run-scoped tmp directories (`.dagclaw/runs/<runId>/tmp/`), isolated per orchestrator instance

### `core/memoryDistiller.ts` — Post-Run Knowledge Extraction

After a successful run, distills what was learned into a structured memory file:

- `DISTILLATION_SYSTEM_PROMPT` — instructs Claude to produce structured markdown: `# Title` → `> one-liner` → `## Summary` → `## Key Patterns` → `## Gotchas` → `## Reusable Insights`
- `distillMemory(runId, state, logger, memoryManager, opts, runner?)` — the main function:
  1. Builds a prompt from `PipelineState` (plan summary, subtask descriptions + outcomes, verification result)
  2. Calls Claude (Sonnet by default, configurable via `--distill-model`)
  3. Extracts clean text from NDJSON stream via `extractTextFromStreamJson()` in claudeRunner
  4. Saves three copies: raw log via `logger.appendStageLog()`, per-run `memory.md` via `logger.writeRunMemory()`, project-level `.dagclaw/memory/<runId>.md` via `memoryManager.writeFile()`
  5. Updates `index.md` via `memoryManager.updateIndex()`
- No tools given to Claude (`allowedTools: []`) — pure text generation
- Errors are caught and logged, never thrown (distillation failure should not break the pipeline)

### `core/memoryManager.ts` — Memory Storage & Retrieval

Manages `.dagclaw/memory/` directory. Two responsibilities: writing structured memory files, and reading them back as context for future runs.

**Writing:**
- `writeFile(filename, content)` — writes a memory file
- `updateIndex()` — regenerates `index.md` as a 3-column markdown table (Run | Title | Summary) by parsing all memory files

**Reading:**
- `readAll()` — concatenates all markdown files with `### filename` headers, index.md sorted first
- `buildContextBlock(maxChars?)` — wraps `readAll()` with `--- Project Memory ---` header, optional truncation. Currently dumps ALL files (no selection)
- `readFile(filename)` — reads a single memory file
- `listFiles()` — lists all `.md` files in memory directory
- `readSummaries()` — returns `MemoryEntry[]` with parsed structured fields from each file (for future two-phase retrieval)

**MemoryEntry interface** (structured parsing for retrieval):
```typescript
interface MemoryEntry {
  filename: string;  // e.g. "2026-03-10T02-22-18_641f0bd9.md"
  title: string;     // parsed from # H1
  oneliner: string;  // parsed from > blockquote
  summary: string;   // parsed from ## Summary section
}
```

**Memory injection path:** `taskOrchestrator.ts` calls `buildContextBlock()` once at pipeline start → stored in `state.memoryContext` (immutable for entire run) → injected into Plan and Execute stages via `{{memoryContext}}` template interpolation. Verify stage does NOT receive memory.

## How to Add a Custom Stage

**Option A: Config file (declarative)**
1. Create `dagclaw.config.json` in your project root:
   ```json
   {
     "stages": {
       "Lint": {
         "name": "Lint",
         "runnerConfig": {
           "systemPrompt": "You are a linting agent...",
           "promptTemplate": "Working directory: {{workDir}}\n...",
           "allowedTools": ["Read", "Bash", "Glob", "Grep"]
         }
       }
     }
   }
   ```
2. Use it: `--pipeline "Plan,Execute,Lint,Verify"`
3. To make the planner assign it to DAG subtasks: `--dag-stages "Execute,Lint"`

**Option B: TypeScript config (full control)**
1. Create `dagclaw.config.ts` with `export default { stages: { ... } }` using full `StageDefinition` objects with function fields.

**Option C: Built-in (for core stages)**
1. Define a `StageDefinition` in `stageDefinitions.ts`, add to `BUILTIN_STAGES`
2. Needs: `name`, `runnerConfig`, `contextBuilder`, `resultHandler`
3. For parallel stages: add `parallel: true` and `subtaskExtractor`
4. For stages that check results: add `resultInterpreter` and optionally `retryStage`

No changes to the orchestrator needed in any case.

## Backend Server

The backend wraps the core orchestration engine in an Express + WebSocket server for remote/programmatic access.

### Architecture

- **`TaskStore`** manages task lifecycle. Each task wraps a `TaskOrchestrator` instance. The store tracks status transitions (pending → running → completed/failed/cancelled) and forwards `OrchestratorCallbacks` to the WebSocket server for real-time updates.
- **WebSocket** uses a subscription model: clients subscribe to task IDs (`nodeIds`) and receive events (stage start/end, subtask progress, approval requests). A per-node `MessageBuffer` (ring buffer, 1000 entries) ensures late-joining clients get history.
- **REST API** handles task CRUD, stage CRUD, and approval/reject flows.
- **Security** includes API key auth, rate limiting, path traversal prevention, CORS restriction, WebSocket resource limits, body size cap, generic error responses, and security headers.

### REST Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/tasks` | Create a task (prompt, workDir, pipeline, autoApprove) |
| `GET` | `/api/tasks` | List all tasks |
| `GET` | `/api/tasks/:id` | Get task detail |
| `POST` | `/api/tasks/:id/approve` | Approve a pending plan |
| `POST` | `/api/tasks/:id/reject` | Reject a pending plan |
| `DELETE` | `/api/tasks/:id` | Cancel a running task |
| `GET` | `/api/stages` | List all stages (built-in + custom) |
| `POST` | `/api/stages` | Create a custom stage |
| `PUT` | `/api/stages/:name` | Update a custom stage |
| `DELETE` | `/api/stages/:name` | Delete a custom stage |
| `GET` | `/api/runs` | List run summaries (optional `?status=`, `?limit=`) |
| `GET` | `/api/runs/:id` | Get full run manifest |
| `GET` | `/api/tasks/:id/usage` | Get task usage/cost from run manifest |
| `GET` | `/api/health` | Health check |

### WebSocket Protocol

Clients connect to `ws://host:port`. If `CLAW_API_KEY` is set, the first message must be `{"type":"auth","token":"<key>"}` (5-second deadline).

**Client → Server:**
- `{"type":"subscribe","nodeIds":["task-id"]}` — subscribe to task events
- `{"type":"unsubscribe","nodeIds":["task-id"]}` — unsubscribe
- `{"type":"approve_plan","taskId":"..."}` — approve a pending plan
- `{"type":"reject_plan","taskId":"...","feedback":"..."}` — reject with feedback
- `{"type":"cancel","taskId":"..."}` — cancel a task

**Server → Client** (for subscribed tasks):
- `{"type":"stage_start","taskId":"...","label":"Plan"}` — stage started
- `{"type":"stage_complete","taskId":"..."}` — stage ended
- `{"type":"tree_snapshot","taskId":"...","subtasks":[...]}` — DAG initialized
- `{"type":"subtask_start","taskId":"...","index":0}` — subtask started
- `{"type":"subtask_complete","taskId":"...","index":0}` — subtask ended
- `{"type":"approval_required","taskId":"...","message":"..."}` — plan needs approval
- `{"type":"node_status","taskId":"...","message":"..."}` — status update
- `{"type":"usage_update","taskId":"...","usage":{...}}` — live cost/token usage update
- `{"type":"plan_ready","taskId":"...","plan":{...}}` — parsed plan delivered to client
- `{"type":"task_error","taskId":"...","error":"..."}` — task failed with error
- `{"type":"task_complete","taskId":"..."}` — task finished successfully
- `{"type":"verification_result","taskId":"...","result":{...}}` — verification outcome
- `{"type":"retry","taskId":"...","indices":[...]}` — subtasks being retried

### Configuration (Environment Variables)

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | HTTP/WebSocket server port |
| `CLAW_API_KEY` | unset (auth disabled) | API key for HTTP Bearer auth and WS first-message auth |
| `CLAW_ALLOWED_DIR` | `$HOME` | Base directory for workDir validation (path traversal prevention) |
| `CLAW_CORS_ORIGINS` | `http://localhost:5173,http://localhost:3000` | Comma-separated allowed CORS origins |
| `CLAW_MAX_TASKS` | `5` | Maximum concurrent running tasks |
| `CLAW_MAX_WS_CLIENTS` | `100` | Maximum simultaneous WebSocket connections |
| `CLAW_RATE_LIMIT_MAX` | `10` | Max task creation requests per IP per minute |

### Running the Server

```bash
# Full stack (backend + frontend) — recommended
bash scripts/start_server.sh        # starts both, prints local + LAN URLs
bash scripts/stop_server.sh         # stops both

# Backend only (development, no auth)
node --import tsx backend/src/index.ts

# Frontend only (dev server with hot reload)
cd frontend && npm install && npm run dev

# Production (with auth)
CLAW_API_KEY=your-secret-key \
CLAW_ALLOWED_DIR=/home/user/projects \
CLAW_CORS_ORIGINS=https://your-frontend.example.com \
  node --import tsx backend/src/index.ts
```

PID files are stored in `.dagclaw/pids/`. The start script auto-sources nvm if node isn't on PATH, detects LAN IP, and prints access URLs for both local and network access.

## Testing

```bash
# Core + CLI tests (335 tests)
node --import tsx --test 'core/__tests__/*.test.ts' 'cli/__tests__/*.test.ts'

# Backend tests (66 tests)
node --import tsx --test 'backend/__tests__/*.test.ts'

# All tests (401 tests)
node --import tsx --test 'core/__tests__/*.test.ts' 'cli/__tests__/*.test.ts' 'backend/__tests__/*.test.ts'

# Type check
npx tsc --noEmit

# E2E tests (require Claude Code CLI)
bash test_scripts/e2e-hello.sh       # basic single subtask
bash test_scripts/e2e-deps.sh        # DAG dependency diamond
bash test_scripts/e2e-retry.sh       # verify + retry loop
bash test_scripts/e2e-cascade-skip.sh # failure cascade
bash test_scripts/e2e-concurrency.sh  # max-concurrency=1
bash test_scripts/e2e-memory.sh       # memory injection
bash test_scripts/e2e-natural.sh      # open-ended prompt
bash test_scripts/e2e-stale-lock.sh   # stale lock cleanup
bash test_scripts/e2e-empty-task.sh   # zero subtasks
bash test_scripts/e2e-large-dag.sh    # 5-subtask complex DAG
bash test_scripts/e2e-recursive.sh    # recursive decomposition
bash test_scripts/e2e-cost-summary.sh # tree-format cost summary
bash test_scripts/e2e-dag-display.sh  # live DAG status display
bash test_scripts/e2e-custom-stages-json.sh # custom stage via JSON config
bash test_scripts/e2e-custom-stages-ts.sh   # custom stage via TS config
bash test_scripts/e2e-dag-stages.sh   # per-subtask stage routing
```

## Key Design Decisions

1. **Stage-agnostic orchestrator** — all stage differences expressed through `StageDefinition` config, not if/else branches
2. **Single execution primitive** — `runOne()` handles both standalone stages and individual subtasks within parallel stages
3. **Structured output via files** — agents write JSON to run-scoped tmp dirs (`.dagclaw/runs/<runId>/tmp/`), orchestrator validates via each stage's declared `outputSchema` (Zod) and passes parsed data to `resultHandler`. Stages never do their own file I/O. Each orchestrator instance gets isolated tmp.
4. **Data-driven retry** — `retryStage` field on StageDefinition tells the orchestrator what to re-run. No hardcoded stage names in retry logic.
5. **Cascade-skip via throw** — Execute `resultHandler` throws on `success: false`, caught by `Promise.allSettled` in DAG runner, which calls `markSkipped()` to cascade.
6. **Immutable run logs** — every prompt, output, and verification attempt is preserved with numbering. Nothing is overwritten.
7. **System prompt interpolation** — both system prompts and prompt templates are interpolated with `{{key}}` placeholders from `contextBuilder`. Enables runtime injection of pipeline metadata (DAG palette, post-stages) into the planner.
8. **Per-subtask stage routing** — subtasks can specify a `stage` field to run through different stage definitions. The Plan stage validates stage references against the DAG palette. Only Execute-stage subtasks can be recursively decomposed.
9. **Custom stages via config** — `dagclaw.config.json` (declarative, Zod-validated) or `dagclaw.config.ts` (full `StageDefinition` with functions). Merged with built-ins at startup. Reserved names protected.
10. **DagDisplay as sole stdout coordinator** — during active DAG display, all stdout writes go through `DagDisplay.writeStatus()` (via `dagAwareLog` in cli.ts) to prevent interleaved writes from breaking ANSI cursor math.

## Memory Structure

Memory files live in `.dagclaw/memory/` and are named after run IDs (e.g., `2026-03-10T02-22-18_641f0bd9.md`). Each file follows a structured format designed for progressive retrieval:

```markdown
# Human-Readable Title Describing What Was Done

> One-line summary (max 150 chars) for index scanning and relevance assessment.

## Summary

100-200 word narrative covering: what the task accomplished, approach taken,
key technical decisions, and outcome. Helps a model decide whether to read
the detailed sections below.

## Key Patterns
- Specific, reusable patterns discovered during the run

## Gotchas
- Pitfalls and edge cases encountered

## Reusable Insights
- Techniques applicable to future runs
```

**Two-tier storage:**
- **Per-run** (`.dagclaw/runs/<id>/memory.md`) — copy of the distilled memory, tied to the run's log directory
- **Project-level** (`.dagclaw/memory/<runId>.md`) — the shared memory pool read by future runs

**Index** (`.dagclaw/memory/index.md`) — auto-generated 3-column markdown table: `| Run | Title | Summary |`. Titles and one-liners are parsed from each memory file. Designed for a future two-phase retrieval system (v0.2) where a model scans the index → selects candidates → reads summaries → narrows to 10-20 most relevant → composes detailed context.

**Current limitation:** `buildContextBlock()` dumps ALL memory files into context with no selection. This works for early runs but will need the two-phase retrieval system as memory accumulates.

## Frontend

React SPA built with Vite, Tailwind CSS, xterm.js, and Zustand. Communicates with the backend via REST (task creation, listing) and WebSocket (real-time updates, approval flow, terminal output).

### Architecture

**Three-panel layout** (`App.tsx`):
- **Left:** `Sidebar` — task list, create task form, connection indicator
- **Center:** `TaskTreeView` — DAG visualization with subtask nodes showing status
- **Right:** `DetailPanel` — plan view, execution view (terminal output), verification results, stage indicator

**State management** (`stores/orchestratorStore.ts`):
- Zustand store with `rootTasks`, `nodeMap`, `plans`, `verifications`, `subtaskStatuses`, `stageInfo`
- `handleWsMessage()` dispatches all WS events to state updates
- Derived selectors for selected task, plan, verification, stage info

**WebSocket** (`hooks/useWebSocket.ts`):
- Singleton connection with exponential backoff reconnection (1s → 30s max)
- Auto-resubscribes to active task subscriptions on reconnect
- `subtask_output` messages bypass Zustand and go directly to xterm.js terminals via a callback registry (performance: avoids re-renders for high-frequency terminal data)
- LAN-aware URL: uses `window.location.host` when not on localhost

**Components:**
| Component | Purpose |
|-----------|---------|
| `Sidebar` | Task list with status badges, `CreateTaskForm` for new tasks |
| `CreateTaskForm` | Prompt input, workDir, pipeline, autoApprove toggle |
| `TaskTreeView` | DAG node layout with `TaskTreeNode` per subtask |
| `TaskTreeNode` | Single node: status icon, description, dependency arrows |
| `DetailPanel` | Tabbed detail view for selected task |
| `StageIndicator` | Shows current pipeline stage (Plan/Execute/Verify) |
| `PlanView` | Displays plan summary, subtask list, quality flags |
| `ExecutionView` | Per-subtask `SubtaskTerminal` instances |
| `SubtaskTerminal` | xterm.js terminal showing live Claude output |
| `VerifyView` | Verification results: per-subtask pass/fail, integration check |
| `ApprovalBanner` | Plan approval/reject buttons when awaiting approval |

### Frontend Source Files

```
frontend/
├── src/
│   ├── App.tsx                    Three-panel layout, WS connection init
│   ├── main.tsx                   React entry point
│   ├── types.ts                   Task, Plan, Verification, WS message types
│   ├── index.css                  Tailwind imports
│   ├── stores/
│   │   └── orchestratorStore.ts   Zustand store, WS message handler, selectors
│   ├── hooks/
│   │   └── useWebSocket.ts        Singleton WS, reconnection, subscription mgmt
│   └── components/
│       ├── Sidebar.tsx            Task list + create form
│       ├── CreateTaskForm.tsx     Task creation form
│       ├── TaskTreeView.tsx       DAG visualization
│       ├── TaskTreeNode.tsx       Individual DAG node
│       ├── DetailPanel.tsx        Right panel: plan/exec/verify views
│       ├── StageIndicator.tsx     Current stage badge
│       ├── PlanView.tsx           Plan display
│       ├── ExecutionView.tsx      Subtask terminal container
│       ├── SubtaskTerminal.tsx    xterm.js terminal per subtask
│       ├── VerifyView.tsx         Verification results
│       └── ApprovalBanner.tsx     Approve/reject controls
├── index.html
├── package.json                   Dependencies: react, zustand, xterm, tailwindcss
├── vite.config.ts                 Dev server proxy to backend:3001
└── tailwind.config.js
```
