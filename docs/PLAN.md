# DAGClaw — System Architecture Plan

## Context

DAGClaw is a general-purpose multi-stage recursive orchestration engine. It decomposes tasks into subtasks via configurable pipelines (default: Plan → Execute → Verify), running subtasks in parallel via DAG scheduling with greedy dependency resolution. The engine is domain-agnostic — custom stages make it suitable for software engineering, research, content generation, data processing, or any multi-step task with dependencies.

The architecture supports both human-in-the-loop workflows (plan approval, retry choices) and fully agentic loops (an outer agent invokes `dagclaw` as a tool, receives structured results, iterates). The same accountability properties hold in both modes: the plan is inspectable, run logs capture exactly what happened, the DAG structure constrains execution order, and failed runs can be resumed or replayed.

## Tech Stack

| Layer | Choice | Why |
|-------|--------|-----|
| Backend | **Node.js + Express + TypeScript** | Single language with frontend, native Agent SDK support |
| Claude integration | **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) | Structured async message iterator, session management |
| Real-time transport | **WebSockets** (`ws` library) | Bidirectional — streaming output + control commands (approve/cancel) |
| Frontend | **React + Vite + TypeScript** | Best xterm.js ecosystem, largest community |
| Terminal rendering | **xterm.js** (`@xterm/xterm`) | Handles ANSI codes, colors, cursor — used by VS Code |
| Styling | **Tailwind CSS** | Rapid UI development, utility-first |
| State management | **Zustand** | Lightweight, minimal boilerplate for task tree state |
| Schema validation | **Zod** | Validate structured JSON output from Claude (plans, verification results) |

## Architecture Overview

```
┌──────────────────────────────────────────────────┐
│                 React Frontend                    │
│  ┌──────────┐  ┌────────────┐  ┌──────────────┐ │
│  │ TaskTree  │  │ PlanView   │  │ ExecutionView│ │
│  │ (sidebar) │  │ (approval) │  │ (xterm.js)   │ │
│  └─────┬────┘  └──────┬─────┘  └──────┬───────┘ │
│        └───────────────┼───────────────┘         │
│                  Single WebSocket                 │
└────────────────────────┼─────────────────────────┘
                         │
┌────────────────────────┼─────────────────────────┐
│                Express Backend                    │
│                        │                          │
│  ┌─────────────────────▼──────────────────────┐  │
│  │            TaskManager (registry)           │  │
│  └─────────────────────┬──────────────────────┘  │
│                        │                          │
│  ┌─────────────────────▼──────────────────────┐  │
│  │         TaskOrchestrator (per node)         │  │
│  │   stagePipeline: [Plan, Execute, Verify]    │  │
│  └──────────────────┬────────────────────────┘   │
│                     │ resolves StageDefinition    │
│           ┌─────────▼──────────┐                 │
│           │   ClaudeRunner     │ ← generic       │
│           │ (config-driven)    │   wrapper        │
│           │                    │                  │
│           │ single or N ∥      │                  │
│           │ instances per stage │                  │
│           └────────────────────┘                  │
│                                                   │
│  REST: /api/tasks    WS: single global connection │
└───────────────────────────────────────────────────┘
```

## Core Data Model

### TaskNode — the fundamental unit

Every task (root or nested) is a `TaskNode`. They form a tree via `parentId`/`children`.

```typescript
interface TaskNode {
  id: string;                        // UUID
  parentId: string | null;           // null for root tasks
  prompt: string;
  workDir: string;
  stagePipeline: string[];           // e.g. ["Plan", "Execute", "Verify"] — names resolve to StageDefinitions
  stageOverrides?: Record<string, Partial<StageDefinition>>;  // per-task stage customization
  currentStageIndex: number;         // -1 = not started
  status: "pending" | "running" | "awaiting_approval" | "completed" | "failed" | "cancelled";
  stages: Record<string, StageState>;
  plan: Plan | null;                 // populated after Plan stage
  children: string[];                // child TaskNode IDs
  autoApprove: boolean;
  maxRetries: number;                // max verify→re-execute cycles
  permissionMode: PermissionMode;    // controls Claude Code's built-in permission checks
}

// Permission control for Claude Code instances
type PermissionMode =
  | "interactive"       // default — Claude Code asks user before executing tools (Bash, Edit, etc.)
  | "auto"              // fully automatic — skip all permission prompts (--dangerously-skip-permissions)
  | "plan-only";        // Plan stage is interactive, Execute/Verify stages are auto-approved

interface StageState {
  status: "pending" | "running" | "completed" | "failed";
  retryCount: number;
  output: any;
  error: string | null;
}
```

### Plan — structured output from Plan stage

```typescript
interface Plan {
  summary: string;
  subtasks: Subtask[];
}

interface Subtask {
  index: number;
  description: string;
  prompt: string;                         // self-contained prompt for executor
  dependencies: number[];                 // indices of prerequisite subtasks
  estimatedComplexity: "low" | "medium" | "high";
  needsRecursiveDecomposition: boolean;   // if true, spawns child TaskNode with own pipeline
}
```

### VerificationResult — output from Verify stage

```typescript
interface VerificationResult {
  overallPass: boolean;
  subtaskResults: { subtaskIndex: number; pass: boolean; summary: string; retryRecommended: boolean }[];
  integrationResult: { pass: boolean; summary: string; issues: string[] };
}
```

## Key Backend Components

### 1. TaskOrchestrator (`backend/src/services/taskOrchestrator.ts`)

One instance per TaskNode. Drives the node through its `stagePipeline` sequentially:

```
for each stage in pipeline:
  run StageRunner (resolved from stage config)
  if stage has approvalRequired flag:
    pause, emit "approval_required", await user approval
  on failure: mark node failed, stop
mark node completed
```

### 2. Generic ClaudeRunner (`src/claudeRunner.ts`)

**The core execution module.** A consolidated set of functional exports for running Claude, building prompts, parsing structured output, and tracking usage. No class — just pure functions and one async execution function.

```typescript
// v0.1.0: Claude-only backends
type RunnerBackend =
  | { type: "sdk" }    // Agent SDK: @anthropic-ai/claude-agent-sdk query()
  | { type: "cli" }    // CLI: `claude -p --output-format stream-json`

// Stage runner config — each stage provides partial config, orchestrator fills in the rest
interface ClaudeRunnerConfig {
  systemPrompt?: string;       // stage-specific instructions
  promptTemplate?: string;     // template with {{placeholders}} for runtime data
  allowedTools?: string[];     // Claude Code tools to allow (default: all)
  timeoutMs?: number;          // per-subtask timeout (default 300000 = 5 min)
}

// Options for a single Claude invocation
interface RunClaudeOptions {
  prompt: string;                       // interpolated prompt (from buildStagePrompt)
  systemPrompt: string;                 // from stage config
  workDir: string;
  allowedTools?: string[];
  timeoutMs?: number;
  backend: RunnerBackend;
  dangerouslySkipPermissions?: boolean;
}

// Result of a single Claude invocation
interface RunClaudeResult {
  rawOutput: string;       // full stream-json output
  sessionId: string;       // for retrying THIS subtask only
  usage: UsageStats;       // token usage and cost tracking
}
```

**Key exports:**

| Function | Purpose |
|----------|---------|
| `estimateCost(input, output, cacheRead, cacheCreation)` | USD estimate from token counts (Sonnet 4 pricing) |
| `parseUsageFromCliOutput(output)` | Extract `UsageStats` from CLI stream-json result line |
| `checkClaudeCli()` | Check if `claude` binary is on PATH |
| `buildStagePrompt(template, context)` | Interpolate `{{placeholders}}` in prompt template |
| `parseStageOutput(schema, rawJson)` | Validate JSON string against a Zod schema |
| `parseStageOutputFile(schema, filePath)` | Read file + validate against a Zod schema |
| `runClaudeCli(options)` | Spawn `claude -p`, collect output, parse usage + sessionId |

**Structured output via files (not text parsing):**
Agents write structured JSON to `.dagclaw/tmp/` files. The orchestrator's `runOne()` validates output via each stage's declared `outputSchema` using `parseStageOutputFile()`, then passes the parsed result to `resultHandler`:
- Plan → `.dagclaw/tmp/plan.json` (PlanSchema)
- Execute subtask N → `.dagclaw/tmp/subtask-N-summary.json` (ExecutorOutputSchema)
- Verify → `.dagclaw/tmp/verification.json` (VerificationResultSchema)

**Backend selection logic (v0.1.0):**
- CLI backend: spawns `claude -p --output-format stream-json` as subprocess. No API key needed — uses Claude Code's own auth.
- SDK backend: placeholder for future Agent SDK integration. `--backend sdk` or `--backend cli` to select.
- Custom CLI command backends deferred to v0.2+.

**Context flow via snapshots:**
Each subtask produces a `ContextSnapshot` on completion. The stage's `resultHandler` stores snapshots in `PipelineState.subtaskSnapshots`. Dependent subtasks receive predecessor context via `contextBuilder`. This enables clean parallel forking (all Execute subtasks inherit Plan context) and DAG accumulation (dependent subtasks get predecessors' snapshots).

### 3. Stage Definitions (`src/stageDefinitions.ts`)

Each stage is a `StageDefinition` config with three key functions: `contextBuilder` (how to build prompt context from pipeline state), `resultHandler` (how to parse output and update pipeline state), and `formatStatus` (CLI display). The orchestrator treats all stages identically.

```typescript
// Shared state flowing through the pipeline — each stage reads and writes to this.
interface PipelineState {
  prompt: string;
  workDir: string;
  plan: Plan | null;
  subtaskSnapshots: Map<number, ContextSnapshot>;
  skippedIndices: Set<number>;
  memoryContext: string;
  verification: VerificationResult | null;
}

interface StageDefinition {
  name: string;
  runnerConfig: Partial<ClaudeRunnerConfig>;

  // Stage behavior flags
  approvalRequired?: boolean;
  parallel?: boolean;                  // if true, uses DAG from subtaskExtractor

  // Lifecycle functions — each stage implements these
  subtaskExtractor?: (state: PipelineState) => SubtaskDefinition[];
  contextBuilder: (state: PipelineState, outputFile: string, subtask?: SubtaskDefinition) => Record<string, string>;
  resultHandler: (state: PipelineState, parsedOutput: unknown | null, subtask?: SubtaskDefinition, sessionId?: string) => string;

  // Optional
  resultInterpreter?: (output: any) => { pass: boolean; failedIndices?: number[] };
  integrationVerifier?: boolean;
  maxRetries?: number;
  formatStatus?: (subtask?: SubtaskDefinition, status?: string) => string;
}
```

Each built-in stage (Plan, Execute, Verify) implements `contextBuilder` and `resultHandler`. The orchestrator validates structured output via the declared `outputSchema` and passes the parsed result to `resultHandler` — stages never do their own file I/O or parsing. For example, Plan's `contextBuilder` maps pipeline state to `{workDir, prompt, memoryContext, outputFile}`, and its `resultHandler` receives the validated `Plan` object and sets `state.plan`. Execute's `contextBuilder` includes predecessor subtask summaries from `state.subtaskSnapshots` (wired via `subtask.dependencies`), and its `resultHandler` builds a `ContextSnapshot`. This eliminates stage-specific code from the orchestrator.

### 4. Stage Resolution in TaskOrchestrator

The orchestrator has a **single execution primitive** (`runOne`) that handles both standalone stages and individual subtasks within a parallel stage:

```
for each stageName in pipeline:
  stage = resolveStage(stageName)

  if stage.parallel && stage.subtaskExtractor:
    subtasks = stage.subtaskExtractor(state)
    schedule via DependencyResolver, calling runOne(stage, state, subtask) for each
  else:
    runOne(stage, state)

  if stage.approvalRequired && !autoApprove:
    prompt for approval

runOne(stage, state, subtask?):
  context = stage.contextBuilder(state, outputFile, subtask)
  prompt = interpolate(stage.runnerConfig.promptTemplate, context)
  result = runClaudeCli(prompt, systemPrompt, ...)
  parsedOutput = stage.outputSchema ? parseStageOutputFile(stage.outputSchema, outputFile) : null
  message = stage.resultHandler(state, parsedOutput, subtask, result.sessionId)
```

There are no stage-specific methods in the orchestrator. All stage differences are expressed through the `StageDefinition` config functions.

### 4.1 User-defined Custom Stages

Users can define custom stages by providing a `StageDefinition` object. Since stages are pure config (system prompt, template, and three functions), adding a new stage requires no changes to the orchestrator or runner.

**Minimal example — a "Test" stage:**

```typescript
const TestStage: StageDefinition = {
  name: "Test",
  runnerConfig: {
    systemPrompt: "You are a testing agent. Write and run tests for the code changes.",
    promptTemplate: "Working directory: {{workDir}}\nPlan: {{planSummary}}\nWrite and run tests.\nWrite results to: {{outputFile}}",
    allowedTools: ["Read", "Write", "Bash", "Glob", "Grep"],
  },

  // contextBuilder: map pipeline state → template variables
  contextBuilder: (state, outputFile) => ({
    workDir: state.workDir,
    planSummary: state.plan?.summary ?? '',
    outputFile,
  }),

  // resultHandler: process validated output, update state, return display message
  resultHandler: (state, parsedOutput) => {
    if (!parsedOutput) return '[Test] Could not parse test results.';
    const result = parsedOutput as { passed: number; failed: number; allPassed: boolean };
    return `[Test] ${result.passed} passed, ${result.failed} failed`;
  },

  resultInterpreter: (output) => ({
    pass: output.allPassed,
    failedIndices: [],
  }),
  maxRetries: 2,
};

// Use in pipeline: --pipeline "Plan,Execute,Test,Verify"
```

**Registration (v0.1.0):** Custom stages are registered programmatically by adding to `BUILTIN_STAGES`. In v0.2+, users will be able to define stages in a `dagclaw.config.json` file in their project root, which the CLI loads on startup.

**Key constraints for custom stages:**
- `contextBuilder` must return a `Record<string, string>` that matches the `{{placeholders}}` in `promptTemplate`
- `resultHandler` receives the validated output (parsed via `outputSchema`) and updates `PipelineState` as needed
- Parallel stages must provide `subtaskExtractor` to derive subtask list from pipeline state
- Custom stages have access to the full `PipelineState`, so they can read plan context, predecessor snapshots, memory, etc.

### 5. DependencyResolver (`src/dependencyResolver.ts`)

Topological sort utility for the subtask DAG (used by any stage with `parallel: true`):
- `getReady()` — returns subtasks whose dependencies are all complete
- `markComplete(index)` — marks a subtask done
- `markSkipped(index)` — marks a subtask as skipped, cascades to downstream dependents, returns cascaded indices
- `allComplete()` — checks if DAG is fully resolved

### 6. TaskManager (`backend/src/services/taskManager.ts`)

Registry of all TaskNodes. Responsibilities:
- Create root tasks and child tasks
- Look up nodes by ID
- Manage stage definition registry (built-in + user-defined)
- Walk the tree for cancellation (cancel node + all descendants)
- Provide tree snapshots for the REST API

## WebSocket Protocol

**Single global connection** — the client subscribes to specific node IDs and receives multiplexed updates.

### Client → Server
```typescript
| { type: "subscribe", nodeIds: string[] }
| { type: "unsubscribe", nodeIds: string[] }
| { type: "approve_plan", nodeId: string }
| { type: "reject_plan", nodeId: string, feedback?: string }
| { type: "cancel", nodeId: string }
```

### Server → Client
```typescript
| { type: "tree_snapshot", rootNodeId: string, tree: TaskNodeSummary }
| { type: "node_created", node: TaskNodeSummary, parentId: string | null }
| { type: "node_status", nodeId: string, status: string }
| { type: "stage_start", nodeId: string, stage: string }
| { type: "stage_complete", nodeId: string, stage: string, output: any }
| { type: "subtask_start", nodeId: string, subtaskIndex: number }
| { type: "subtask_output", nodeId: string, subtaskIndex: number, data: string }
| { type: "subtask_complete", nodeId: string, subtaskIndex: number }
| { type: "approval_required", nodeId: string, plan: Plan }
| { type: "verification_result", nodeId: string, result: VerificationResult }
| { type: "retry", nodeId: string, subtaskIndex: number, attempt: number }
```

Each node maintains a ring buffer (default 1000 lines) for late-joining clients.

## REST API

### Tasks
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/tasks` | Create root task (prompt, workDir, pipeline, autoApprove, maxRetries, stageOverrides) |
| GET | `/api/tasks` | List root tasks with summary |
| GET | `/api/tasks/:id` | Full TaskNode detail |
| GET | `/api/tasks/:id/tree` | Full tree rooted at this node |
| POST | `/api/tasks/:id/approve` | Approve a pending stage |
| POST | `/api/tasks/:id/reject` | Reject with optional feedback |
| DELETE | `/api/tasks/:id` | Cancel node and all descendants |

### Stage Definitions
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/stages` | List all stage definitions (built-in + custom) |
| POST | `/api/stages` | Register a custom stage definition |
| PUT | `/api/stages/:name` | Update a custom stage definition |
| DELETE | `/api/stages/:name` | Remove a custom stage definition (built-ins cannot be deleted) |

## Project Structure

```
claw_ui/
├── backend/
│   ├── src/
│   │   ├── index.ts                    # Express + WS server entry
│   │   ├── types.ts                    # All shared types
│   │   ├── routes/
│   │   │   ├── tasks.ts               # Task REST endpoints
│   │   │   └── stages.ts              # Stage definition CRUD endpoints
│   │   ├── services/
│   │   │   ├── claudeRunner.ts         # Generic Claude Code wrapper (core abstraction)
│   │   │   ├── stageDefinitions.ts     # Built-in stage configs + registry for custom stages
│   │   │   ├── taskManager.ts          # Node registry + tree operations
│   │   │   ├── taskOrchestrator.ts     # Drives node through stage pipeline (generic logic)
│   │   │   └── dependencyResolver.ts   # DAG topological sort
│   │   └── websocket/
│   │       ├── wsServer.ts             # Global WS server
│   │       ├── subscriptionManager.ts  # Client subscription tracking
│   │       └── messageBuffer.ts        # Per-node ring buffer
│   ├── package.json
│   └── tsconfig.json
├── frontend/
│   ├── src/
│   │   ├── App.tsx                     # Root layout
│   │   ├── types.ts                    # Frontend types
│   │   ├── components/
│   │   │   ├── Sidebar.tsx             # Root task list + create button
│   │   │   ├── CreateTaskForm.tsx      # Prompt, workDir, pipeline config
│   │   │   ├── TaskTreeView.tsx        # Tree visualization
│   │   │   ├── TaskTreeNode.tsx        # Recursive tree node component
│   │   │   ├── StageIndicator.tsx      # Colored stage progress bar
│   │   │   ├── DetailPanel.tsx         # Selected node detail view
│   │   │   ├── PlanView.tsx            # Plan display + approve/reject
│   │   │   ├── ExecutionView.tsx       # Grid of subtask terminals
│   │   │   ├── SubtaskTerminal.tsx     # xterm.js per subtask
│   │   │   ├── VerifyView.tsx          # Verification results
│   │   │   └── ApprovalBanner.tsx      # Floating approval prompt
│   │   ├── hooks/
│   │   │   ├── useWebSocket.ts         # Single global WS connection
│   │   │   └── useTerminalOutput.ts    # Writes WS messages to xterm ref
│   │   └── stores/
│   │       └── orchestratorStore.ts    # Task tree state + UI state
│   ├── package.json
│   ├── vite.config.ts
│   └── tailwind.config.js
├── package.json                         # Root workspace (npm workspaces)
├── README.md
├── PLAN.md
└── CLAUDE.md
```

## Frontend Architecture

### Layout
- **Left sidebar**: list of root tasks with status badges, "New Task" button
- **Center**: `TaskTreeView` — indented tree of all nodes for the selected root task, each showing a `StageIndicator` (colored segments: gray=pending, blue=running, green=done, red=failed, yellow=awaiting approval)
- **Right/bottom**: `DetailPanel` — detail view for the selected node, switching between `PlanView`, `ExecutionView`, or `VerifyView` based on the current stage

### State Management (Zustand)
- `rootTasks[]` — top-level task summaries
- `nodeMap: Map<id, TaskNodeSummary>` — flat lookup for all nodes
- `selectedRootId`, `selectedNodeId`, `expandedNodes` — UI state
- WebSocket message handlers update the store; React components subscribe via selectors

### Streaming Output
- `subtask_output` messages are written directly to xterm.js refs, NOT stored in Zustand (too high volume)
- xterm.js itself is the buffer for terminal content
- Ring buffer replay on subscribe handles late-joining

## Implementation Order — Bootstrapping Strategy

The key insight: **Phase 0 builds the orchestrator as a CLI tool, then Phases 1+ use that tool to build itself.**

Phase 0 is hand-written (~7 files, minimal). Once it works, we feed it prompts like:
```bash
npx claw "Build the Express + WebSocket backend server for DAGClaw per PLAN.md"
```
and it Plans → Executes → Verifies autonomously.

---

### Phase 0: Bootstrap CLI (built by Claude Code directly) — ✅ COMPLETE

**Status**: All 10 source files implemented. 125 tests passing. TypeScript type-checks clean. CLI entry point functional.

**Files (all under `src/`):**

```
claw_ui/
├── src/
│   ├── cli.ts                    ✅ CLI entry: arg parsing, plan approval, run history
│   ├── types.ts                  ✅ All interfaces, Zod schemas, enums
│   ├── claudeRunner.ts           ✅ CLI spawning, output parsing, usage tracking, cost estimation
│   ├── promptBuilder.ts          ✅ Template interpolation, snapshot formatting, cache-optimized ordering
│   ├── stageDefinitions.ts       ✅ Plan/Execute/Verify configs with contextBuilder, resultHandler
│   ├── dependencyResolver.ts     ✅ DAG topological sort, cycle detection, cascade skipping
│   ├── taskOrchestrator.ts       ✅ Pipeline driver, runOne(), runDAG(), plan approval
│   ├── taskManager.ts            ✅ Lockfile management, task node factory
│   ├── runLogger.ts              ✅ Manifest persistence, usage tracking, run history
│   └── memoryManager.ts          ✅ Memory reading/writing, context injection
├── bin/claw.js                   ✅ Entry point (tsx loader)
├── package.json                  ✅ deps: tsx, zod
├── tsconfig.json                 ✅
├── PLAN.md
├── CLAUDE.md
└── README.md
```

**CLI interface:**
```bash
# Basic usage — runs Plan → Execute → Verify
# Default: interactive mode (Claude Code asks before each tool execution)
npx claw "Add error handling to the auth module"

# Custom pipeline
npx claw --pipeline "Plan,Execute,Test,Verify" "Refactor the database layer"

# Permission modes
npx claw "fix the bug"                          # interactive (default) — asks before every tool use
npx claw --yolo "fix the bug"                   # fully automatic — no permission prompts at all
npx claw --auto-execute "fix the bug"           # plan stage is interactive, execution is automatic

# Backend selection
npx claw "fix the bug"                          # default: Agent SDK
npx claw --backend cli "fix the bug"            # CLI fallback: claude -p (uses Claude Code's own auth)
npx claw --backend "codex" "fix the bug"        # custom tool: any CLI that accepts prompts

# Other options
npx claw \
  --workdir ./my-project \
  --pipeline "Plan,Execute,Verify" \
  --auto-approve \               # skip plan approval (default: prompt in terminal)
  --max-retries 3 \
  --max-concurrency 5 \
  --max-depth 3 \
  "Build the REST API per PLAN.md"
```

**Permission modes explained:**
- `interactive` (default): Claude Code's built-in permission system is fully active. Each Claude Code instance will ask the user before running Bash commands, editing files, etc. This is the safest mode — you see and approve every action.
- `--yolo` / `--auto`: Passes `--dangerously-skip-permissions` to Claude Code instances. Fully autonomous — no user prompts. Use for trusted, well-tested workflows.
- `--auto-execute`: Hybrid — the Plan stage runs in interactive mode (you review the plan and approve tool uses), but once you approve the plan, Execute and Verify stages run autonomously. Good middle ground for when you trust the plan but want to review it first.

**CLI output** — live terminal display with TTY in-place updates (non-TTY: sequential log lines):
```
[Plan] Running... (0s)               ← live elapsed ticker, overwrites in-place
[Plan] Running... (3s)
                                      ← ticker cleared when Plan completes
[Plan] Generated plan: 3 subtask(s) — Set up Express routes | Implement WebSocket | Wire up task manager
  ├── [0] Set up Express routes (low)
  ├── [1] Implement WebSocket server (medium, depends on 0)
  └── [2] Wire up task manager (low, depends on 0)
[Plan] Approve this plan? (y/n/edit): y

                                      ← Live DAG display (mutable zone):
[Execute] [0] Set up Express routes -- running... (5s)
[Execute] [1] Implement WebSocket -- running... (3s)
  Waiting: [2] blocked on [0, 1]
                                      ← Running lines overwrite in-place every 500ms
                                      ← When [0] completes, its line locks permanently above:

[Execute] [0] Set up Express routes -- done (12s)
[Execute] [1] Implement WebSocket -- running... (8s)
[Execute] [2] Wire up task manager -- running... (5s)

[Execute] [0] Set up Express routes -- done (12s)
[Execute] [1] Implement WebSocket -- done (15s)
[Execute] [2] Wire up task manager -- done (10s)

[Verify] Running... (0s)             ← stage ticker for Verify
[Verify] All checks passed.

✓ Task completed successfully.

[Cost] Total: ~$0.42 | Tokens: 18.2k in / 12.1k out | Duration: 3m 24s
  |-- [Plan]    $0.08  (4.1k in / 2.3k out)
  |-- [Execute] $0.28  (10.5k in / 8.1k out)  <- 3 subtasks
  +-- [Verify]  $0.06  (3.6k in / 1.7k out)
```

**Live DAG display** (`src/dagDisplay.ts`): Renders DAG execution progress. TTY mode uses ANSI cursor-up/clear-line codes to overwrite running lines in-place while completed lines stay permanently above. Non-TTY mode prints sequential log lines. A 500ms timer ticks elapsed time on running tasks. `DagDisplay.writeStatus()` coordinates all stdout writes during active display to prevent interleaved output from breaking cursor math. Standalone stages (Plan, Verify) get their own elapsed ticker via `stageStart()`/`stageEnd()`.

**Plan approval in CLI**: When `--auto-approve` is not set, the CLI prints the plan and prompts `Approve? (y/n/edit)`. On `n`, it aborts. On `edit`, it opens the plan JSON in `$EDITOR` and re-reads it. On `y`, it continues.

**What's intentionally deferred:**
- No web UI, REST, or WebSocket
- No ring buffers or subscription management

---

### End-to-end validation (continuous)

End-to-end evaluation is continuous — we always need it, but we cannot exhaust all cases. E2E test scripts live in `test_scripts/` and cover scenarios like hello-world, concurrency, cascade skip, memory, retry, recursive decomposition, custom stages, live DAG display, and cost summary. Each new feature should add or update an e2e script. Run them manually to validate real Claude CLI behavior:

```bash
bash test_scripts/e2e-hello.sh             # basic single-subtask pipeline
bash test_scripts/e2e-recursive.sh         # recursive decomposition with child orchestrators
bash test_scripts/e2e-cost-summary.sh      # tree-format cost summary
bash test_scripts/e2e-dag-display.sh       # live DAG status display
bash test_scripts/e2e-custom-stages-json.sh # custom stage via dagclaw.config.json
bash test_scripts/e2e-custom-stages-ts.sh   # custom stage via dagclaw.config.ts
bash test_scripts/e2e-dag-stages.sh        # per-subtask stage routing
```

---

### Phase 1: Use `claw` to build itself — Recursive Decomposition

Now feed `claw` its first real task — adding recursive decomposition to itself:
```bash
npx claw --workdir . --auto-approve \
  "Add recursive decomposition support to the task orchestrator.
   When a subtask has needsRecursiveDecomposition: true, create a child
   TaskNode with its own Plan/Execute/Verify pipeline and a child
   TaskOrchestrator. Update taskManager.ts to track parent/child
   relationships. Refer to PLAN.md for the full design."
```

---

### Phase 2: Use `claw` to build — Custom Stage Support

```bash
npx claw --workdir . \
  "Add custom stage definition support. Users should be able to define
   custom StageDefinitions in a dagclaw.config.json file in their project
   root. The CLI should load these and make them available in --pipeline.
   Refer to PLAN.md section 'Stage Definitions' for the StageDefinition
   interface."
```

---

### Phase 3: Use `claw` to build — Backend Server

```bash
npx claw --workdir . \
  "Build the Express + WebSocket backend server for DAGClaw.
   Move the core engine (claudeRunner, taskOrchestrator, etc.) into
   a shared core/ directory. Create backend/ with Express server,
   REST routes for tasks and stages, and WebSocket server with
   subscription management and message buffering.
   The CLI and backend should share the same core engine.
   Refer to PLAN.md for full REST API spec and WebSocket protocol."
```

Expected project structure after this phase:
```
claw_ui/
├── core/                         # Shared orchestration engine
│   ├── types.ts
│   ├── claudeRunner.ts
│   ├── stageDefinitions.ts
│   ├── dependencyResolver.ts
│   ├── taskOrchestrator.ts
│   └── taskManager.ts
├── cli/                          # CLI entry point (uses core/)
│   └── cli.ts
├── backend/                      # Express server (uses core/)
│   ├── src/
│   │   ├── index.ts
│   │   ├── routes/
│   │   │   ├── tasks.ts
│   │   │   └── stages.ts
│   │   └── websocket/
│   │       ├── wsServer.ts
│   │       ├── subscriptionManager.ts
│   │       └── messageBuffer.ts
│   └── package.json
├── package.json
└── ...
```

---

### Phase 4: Use `claw` to build — Frontend

```bash
npx claw --workdir . \
  "Build the React + Vite frontend for DAGClaw.
   Scaffold with Vite + React-TS. Add Tailwind CSS, xterm.js, Zustand.
   Build components: Sidebar, CreateTaskForm, TaskTreeView, TaskTreeNode,
   StageIndicator, DetailPanel, PlanView, ExecutionView, SubtaskTerminal,
   VerifyView, ApprovalBanner.
   Refer to PLAN.md for the frontend architecture, component tree,
   Zustand store shape, and WebSocket protocol."
```

---

### Phase 5: Use `claw` to build — Polish & Integration

```bash
npx claw --workdir . \
  "Polish the DAGClaw application:
   1. Add error handling for SDK failures, WebSocket disconnects, reconnection logic
   2. Add cancellation propagation (cancel root → cancel all descendants)
   3. Add concurrency tuning (MAX_CONCURRENT_INSTANCES env var)
   4. Responsive frontend layout
   5. Update CLAUDE.md with dev commands
   6. Update README.md with setup and usage instructions"
```

---

### Summary: What's hand-written vs. self-built

| Component | How it's built | Status |
|-----------|---------------|--------|
| Core types (`types.ts`) | Claude Code direct (Phase 0) | ✅ Done |
| `ClaudeRunner` | Claude Code direct (Phase 0) | ✅ Done |
| Built-in stage definitions | Claude Code direct (Phase 0) | ✅ Done |
| `DependencyResolver` | Claude Code direct (Phase 0) | ✅ Done |
| `TaskOrchestrator` (basic) | Claude Code direct (Phase 0) | ✅ Done |
| `TaskManager` (minimal) | Claude Code direct (Phase 0) | ✅ Done |
| CLI entry point | Claude Code direct (Phase 0) | ✅ Done |
| End-to-end validation | Continuous (`test_scripts/`) | Ongoing |
| Recursive decomposition | Built by claw (Phase 1) | ✅ Done |
| Custom stages + pipeline-aware planning | Phase 2 | ✅ Done |
| Live DAG display + cost summary | Phase 2.5 | ✅ Done |
| Express + WebSocket backend | Built by claw (Phase 3) | ✅ Done |
| React frontend | Built by claw (Phase 4) | Not started |
| Polish & integration | Built by claw (Phase 5) | Not started |

## Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Generic ClaudeRunner | All stages use same wrapper | Eliminates code duplication; stages differ only in config (prompt, schema, tools) |
| Stages as data, not code | `StageDefinition` configs | Users can define custom stages without writing TypeScript; built-ins are just default configs |
| One orchestrator per node | Yes | Naturally handles recursion; each node drives its own pipeline independently |
| Orchestrator reads definition flags | `parallel`, `approvalRequired`, `resultInterpreter` | Single orchestrator loop handles all stage types via config, no branching on stage name |
| Single global WebSocket | Yes | Avoids connection proliferation; client subscribes/unsubscribes to nodes dynamically |
| Streaming output not in Zustand | xterm.js is the buffer | High-volume terminal data would thrash React re-renders |
| Approval gate via Promise | Orchestrator awaits a Promise resolved by approve endpoint | Clean async flow, no polling |
| Global concurrency semaphore | `MAX_CONCURRENT_INSTANCES=5` | Prevents resource exhaustion from recursive decomposition |
| Max tree depth limit | `MAX_DEPTH=3` | Prevents runaway recursive decomposition |
| Retries at subtask level | Only failed subtasks re-execute | Avoids re-running successful work |
| Interactive permissions by default | Claude Code asks before every tool use | Safety first — user sees and approves all actions; `--yolo` opts into full auto |
| Persistent run logs from v0.1.0 | `.dagclaw/runs/` with manifest + per-subtask logs | History available from day one; web viewer reuses same components later |
| Memory distilled from logs | `.dagclaw/memory/` is derived, `.dagclaw/runs/` is source of truth | Raw logs for accountability, memory for evolving intelligence; user can edit both |
| Concurrency via Plan stage | Claude Code reasons about file conflicts during planning | Minimal structural changes; existing `dependencies` field sufficient; no `touchesFiles` annotation needed |
| Context snapshots, not session chaining | Each subtask owns its session; context flows via snapshots injected into prompts | Sessions can't fork/merge; snapshots enable clean parallel branching and DAG accumulation |
| Cache-optimized prompt ordering | System → memory → plan → snapshots → task prompt | Shared prefix cached at ~90% discount; ~80% cache rate on typical DAGs |
| Simple context budget | `maxContextTokens` cap, drop distant snapshots first | Prevents context bloat; no complex scoring in v0.1.0 |
| Two-tier snapshots | Compact (oneliner+files) for transitive deps, standard (summary) for direct | Lean by default; richer tiers deferred to v0.2+ |
| Escalating retry strategy | Resume own session → pause for user choice → clean slate / escalate / skip / abort | Automatic for simple failures, human-in-the-loop when stuck; key controllability feature |
| Multi-backend support | Agent SDK primary, `claude -p` fallback, custom CLI tools | Flexibility + robustness; users can swap in Codex, Aider, or self-hosted agents |
| Cost tracking from v0.1.0 | Naive CLI display, rich web UI visualization later | Per-subtask token/cost in run manifest; users understand economics of workflows |
| CI integration as just a task | CI failure triggers a templated pipeline, no special code | Everything is a task; CI is just a trigger + template, not a feature |

## Verification

1. **Unit**: Test `DependencyResolver` with various DAG shapes (linear, diamond, independent)
2. **Plan stage**: Create a task, verify JSON plan output is valid and parseable
3. **Execute stage**: Task with 3 subtasks (2 independent, 1 dependent) — verify parallel execution respects deps
4. **Recursive decomposition**: Task where Plan marks a subtask as needing decomposition — verify child TaskNode is created with its own pipeline
5. **Verify + retry**: Deliberately fail a subtask, verify re-execution triggers and retry count increments
6. **Approval flow**: Create task with `autoApprove: false`, verify it pauses after Plan, resumes on approval
7. **Cancellation**: Cancel a running root task, verify all descendants are cancelled
8. **Frontend E2E**: Create a multi-stage task in the UI, watch tree build in real-time, approve plan, observe parallel execution, see verification results

## Persistent Run Logs

Every `claw` run is recorded locally for later review. This is available from v0.1.0 (Phase 0) and becomes browsable in the web UI in Phase 4.

### Storage Layout

```
.dagclaw/
├── runs/
│   ├── 2026-03-04T14-30-00_abc123/       # timestamp + short ID
│   │   ├── manifest.json                  # run metadata, status, timing, tree structure
│   │   ├── plan.json                      # Plan stage output (structured plan)
│   │   ├── subtasks/
│   │   │   ├── 0_setup-routes.log         # full streaming output for subtask 0
│   │   │   ├── 1_websocket-server.log     # full streaming output for subtask 1
│   │   │   └── 2_task-manager.log         # full streaming output for subtask 2
│   │   ├── verification.json              # Verify stage output
│   │   └── children/                      # recursive child runs (if any)
│   │       └── child_def456/
│   │           ├── manifest.json
│   │           └── ...
│   └── 2026-03-04T15-00-00_def456/
│       └── ...
└── config.json                            # global claw settings (optional)
```

### manifest.json

```typescript
interface RunManifest {
  id: string;
  prompt: string;
  workDir: string;
  pipeline: string[];
  backend: string;                   // "sdk", "cli", or custom command
  permissionMode: PermissionMode;
  status: "running" | "completed" | "failed" | "cancelled";
  startedAt: string;                 // ISO timestamp
  completedAt: string | null;
  duration: number | null;           // milliseconds
  tree: TaskNodeSummary;             // full task tree snapshot
  usage: {                           // aggregate cost tracking
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCacheTokens: number;
    estimatedCost: number;           // USD
    perStage: Record<string, UsageStats>;    // breakdown by stage
    perSubtask: Record<number, UsageStats>;  // breakdown by subtask index
  };
  gitInfo?: {
    branch: string;
    commitBefore: string;            // commit hash at start
    commitAfter: string | null;      // commit hash at end (if changes were committed)
    filesModified: string[];         // list of files changed during the run
  };
}
```

### What gets logged
- **Always**: manifest (prompt, config, status, timing), plan JSON, verification JSON
- **Always**: full streaming output per subtask (written line-by-line to `.log` files as output arrives)
- **Always**: git diff summary — which files were created/modified/deleted
- **On completion**: final git state (branch, commit hashes)
- **Recursive runs**: child task logs nested under `children/`

### CLI commands for run history
```bash
npx claw runs                    # list recent runs with status, prompt snippet, duration
npx claw runs --last             # show details of the most recent run
npx claw runs <run-id>           # show details of a specific run
npx claw runs <run-id> --log 2   # cat the full output log for subtask 2
```

### Web UI integration (Phase 4+)
The frontend adds a "Run History" view that reads from `.dagclaw/runs/`. Each run is expandable to show the full task tree, plan, subtask outputs (rendered in xterm.js for ANSI support), and verification results. This reuses the same `TaskTreeView` and `SubtaskTerminal` components — they just read from disk instead of a live WebSocket.

### Retention
- Default: keep last 50 runs (configurable in `.dagclaw/config.json`)
- Oldest runs auto-pruned on new run start
- `npx claw runs --clean` to manually prune

---

## Persistent Memory (Distilled from Run Logs)

Memory is a **derived layer** on top of raw run logs — not a replacement. Raw logs are the source of truth for accountability; memory is the distilled, evolving knowledge that makes future runs smarter.

### How it works

```
Raw logs (.dagclaw/runs/)          Memory (.dagclaw/memory/)
┌──────────────────┐           ┌──────────────────┐
│ run 1 logs       │──distill──▶ codebase.md      │
│ run 2 logs       │──distill──▶ patterns.md      │
│ run 3 logs       │──distill──▶ errors.md        │
│ ...              │           │ ...               │
└──────────────────┘           └──────────────────┘
                                       │
                                       ▼
                               Fed into future
                               Claude Code instances
                               as context
```

### Storage

```
.dagclaw/
├── runs/              # raw logs (source of truth, never modified)
├── memory/
│   ├── index.md       # summary of what memory files exist and when last updated
│   ├── codebase.md    # codebase conventions, architecture notes, key file paths
│   ├── patterns.md    # what worked: successful strategies, useful patterns
│   └── errors.md      # recurring errors and their solutions
└── config.json
```

### Memory lifecycle

1. **After each run completes**, the orchestrator runs a lightweight **memory distillation step**: a Claude Code instance reads the run's plan, execution output, and verification results, then updates the relevant memory files. This is a short, focused prompt: "Given this run's results, update the project memory files with any new learnings."

2. **Before each run starts**, the orchestrator reads `.dagclaw/memory/` and injects relevant content into the Claude Code instances' system context. The Plan stage gets all memory (to inform decomposition); Execute subtasks get memory relevant to their scope.

3. **Memory evolves**: each distillation can update, consolidate, or prune memory entries. Old patterns get refined, outdated info gets removed. The memory files stay concise.

4. **User-editable**: since memory is plain markdown, the user can read, edit, or delete entries at any time. Full transparency and control.

### What gets distilled
- Codebase conventions discovered (naming, architecture, patterns)
- Successful strategies that worked for similar tasks
- Errors encountered and their solutions (avoid repeating mistakes)
- File paths and relationships that are non-obvious
- User preferences observed across runs

### What does NOT go into memory
- Raw output (stays in run logs)
- Temporary/session-specific context
- Anything the user explicitly deletes

### Memory in the web UI (Phase 4+)
The frontend adds a "Memory" panel where users can browse and edit `.dagclaw/memory/` files. Shows when each entry was last updated and which run it originated from.

---

## Concurrency Model

Rather than adding heavy structural annotations (like `touchesFiles` fields), we lean on Claude Code's natural ability to reason about code dependencies during the Plan stage.

### How it works

1. **Plan stage handles conflict detection**: the Plan prompt instructs Claude to consider file dependencies when decomposing subtasks. Subtasks that modify the same files should be listed as dependent. Claude Code already reads the codebase during planning — it naturally knows which subtasks overlap.

2. **DependencyResolver enforces ordering**: the DAG from the Plan stage is the single source of truth for what can run in parallel. If the planner marks subtasks as independent, they run concurrently. If dependent, they serialize. No extra metadata needed.

3. **Global concurrency semaphore**: `MAX_CONCURRENT_INSTANCES` (default 5) caps total parallel Claude Code instances across all nodes. Prevents resource exhaustion.

4. **Git worktree isolation** (future enhancement): for subtasks that truly need to modify overlapping files in parallel, each can run in a git worktree and changes are merged afterward. Deferred — the Plan stage's dependency annotation is sufficient for v0.1.0.

### Why this is minimal

No new fields in `Subtask` or `TaskNode`. The existing `dependencies: number[]` field already handles serialization. The Plan stage prompt is the only thing that changes — we add instructions like: "If two subtasks modify the same files, mark one as dependent on the other."

---

## Context Management

Sessions are linear — they can't fork into parallel branches or merge. Instead of chaining sessions across subtasks, we use **context snapshots + injection**.

### ContextSnapshot

After each stage/subtask completes, the orchestrator captures a snapshot:

```typescript
interface ContextSnapshot {
  nodeId: string;
  stage: string;
  subtaskIndex?: number;
  summary: string;            // what was done, key decisions made
  filesModified: string[];    // which files were created/changed
  keyOutputs: string;         // relevant results for downstream tasks
  sessionId: string;          // for retrying THIS subtask only
}
```

Snapshots are generated by a lightweight extraction from the Claude Code output (parse file changes + run a short summarization prompt). Stored in the run log alongside raw output.

### Prompt assembly (cache-optimized)

The prompt is ordered so the shared prefix maximizes Anthropic's prompt caching (~90% discount on cached tokens):

```
┌──────────────────────────────┐
│ System prompt                │ ← identical across ALL subtasks (always cached)
│ Memory (.dagclaw/memory/)       │ ← identical within a run (cached after 1st subtask)
│ Plan snapshot                │ ← identical for all Execute subtasks (cached)
├──────────────────────────────┤ ← cache breaks here
│ Predecessor snapshots        │ ← varies per subtask
│ Subtask-specific prompt      │ ← unique
└──────────────────────────────┘
```

### Context budget

A simple `maxContextTokens` (default: 2000) caps how much predecessor snapshot content is injected. When over budget, drop snapshots furthest from the current subtask in the DAG (transitive deps before direct deps, older before newer). No fancy relevance scoring in v0.1.0.

### Snapshot tiers (v0.1.0: simple)

Two tiers only:
- **Compact** (~50 tokens): `oneliner` + `filesModified` — used for transitive dependencies
- **Standard** (~200 tokens): `summary` with key decisions — used for direct dependencies

```typescript
interface ContextSnapshot {
  nodeId: string;
  stage: string;
  subtaskIndex?: number;
  oneliner: string;           // compact: "Set up Express routes in src/routes/"
  filesModified: string[];    // compact: which files were created/changed
  summary: string;            // standard: what was done, key decisions
  sessionId: string;          // for retrying THIS subtask only
}
```

Future versions add: full detailed tier, relevance scoring by file overlap, on-demand context tool, context compression for deep DAGs.

### Context flow through the DAG

**Plan → Execute (parallel fork):**
```
Plan produces CS_plan: "Analyzed codebase, decomposed into 3 subtasks..."

Subtask 0: fresh session, prompt = CS_plan + subtask 0's prompt
Subtask 1: fresh session, prompt = CS_plan + subtask 1's prompt
  (both inherit plan context, both build independent context)
```

**Dependent subtasks (context accumulation):**
```
Subtask 2 depends on [0, 1]:
  fresh session, prompt = CS_plan + CS_0 + CS_1 + subtask 2's prompt
  (gets full picture of what predecessors built, including files modified)
```

**Key rules:**
- Every subtask starts its **own session** — no cross-task session sharing
- Plan context is injected into **every** subtask's prompt (shared foundation)
- Predecessor context accumulates along DAG edges
- `sessionId` is stored but only used for retrying the **same** subtask

### Escalating retry strategy

When verification fails for a subtask, retries escalate through stages:

```
Attempt 1-N (auto):
  Resume the failed subtask's own session + inject verification failure details
  (cheapest — the session already has context of what it built)

After N failures → PAUSE and present user with choices:
  [1] Clean slate retry — fresh session with context snapshots from DAG
      (avoids poisoned context from repeated failures)
  [2] Escalate to sub-workflow — create a new Plan→Execute→Verify child task
      (recursive decomposition for the stuck subtask)
  [3] Skip — mark subtask as failed, continue with rest of workflow
  [4] Abort — stop the entire workflow
  [5] Manual fix — user fixes it themselves, then claw re-verifies
```

`N` defaults to `maxRetries` (default 2). The pause-and-choose behavior is the key controllability feature — automatic for simple failures, human-in-the-loop when things get stuck.

In `--yolo` mode, the system auto-escalates: resume retries → clean slate → escalate to sub-workflow → fail. No pause.

### CLI interaction on retry pause

```
[Verify] Subtask 2: ✗ fail — type error in handler (attempt 2/2)
[Verify] Subtask 2 has failed 2 times. Choose an action:
  [1] Clean slate retry (fresh session + context snapshots)
  [2] Escalate (new Plan→Execute→Verify sub-workflow)
  [3] Skip subtask 2 and continue
  [4] Abort entire workflow
  [5] I'll fix it manually, then re-verify
  > _
```

### Web UI resume (Phase 4+)

The web UI's run history view includes a "Resume" action on completed/failed runs. This creates a new run that:
- Reconstructs context snapshots from the previous run's log
- Injects memory from `.dagclaw/memory/` for accumulated learnings
- Pre-populates the DAG state — completed subtasks keep their snapshots, failed subtask gets a fresh start

This gives users a natural "pick up where I left off" workflow.

---

## Future Roadmap (post v0.1.0)

Features identified but explicitly deferred:

| Feature | Version | Notes |
|---------|---------|-------|
| Execute-level retry | v0.1.1 | DAG runner retries failed subtasks before cascade-skipping. Stage config `maxAttempts` controls retry count. Executor output gains `retryWorthy: boolean` — agents signal whether failure is transient (network, flaky test) vs permanent (permission denied, missing prereq). DAG runner skips retry when `retryWorthy: false`. |
| Memory distillation pipeline | v0.1.1 | Activate dead `worthDistilling` flag. After successful run where `plan.worthDistilling === true`, run a distillation Claude CLI call that reads plan + subtask summaries + verification result and generates a memory entry. New `core/memoryDistiller.ts` (~100 lines), minor hook in `taskOrchestrator.ts`. |
| Advanced context management | v0.2+ | Context budget enforcement in `runOne()` — add `contextBudget` to CliOptions, enforce after prompt assembly. Over budget: drop snapshots (compact tier first, oldest transitive deps). ~50-80 lines in `promptBuilder.ts`. Future: relevance scoring (file overlap), on-demand context tool, context compression for deep DAGs, toxicity detection. |
| Sandbox abstraction | v0.2+ | Expanded from git worktree isolation. `sandbox?: 'shared' \| 'worktree'` on SubtaskSchema (planner decides per-subtask). New `core/sandboxManager.ts` (~200 lines) for worktree lifecycle. Docker deferred — worktree covers 90% of code task use cases. |
| Plan replay / dry run | v0.2+ | `--plan <runId>`: load plan.json from previous run, skip Plan stage. `--dry-run`: run Plan stage only, display plan, exit. ~50 lines in cli.ts and taskOrchestrator.ts. Unique advantage over emergent-execution systems. |
| Per-subtask resume | v0.2+ | On run failure, manifest records which subtasks completed successfully. `--resume <runId>`: reload plan, skip completed subtasks, re-run from failure point. More granular than plan replay — avoids re-running successful work. ~80 lines in taskOrchestrator.ts. Inspired by Lobster's checkpoint tokens. |
| Stage lifecycle hooks | v0.2+ | `preRun?` and `postRun?` optional hooks on StageDefinition. NOT middleware — two hooks only. Orchestrator stays stage-agnostic. ~30 lines. |
| External task runner | v0.2+ | `runner: 'claude' \| 'external'` discriminator on StageRunnerConfig. New `runExternal()` in claudeRunner.ts (~150 lines). Shell commands with streaming stdout/stderr capture to log files. Verify stage references external run output for validation. |
| CI integration | v0.2+ | Trigger a templated task pipeline on CI failure (just another task, no special handling) |
| Shareable stage presets | v0.2+ | Reframed from skill packs. Importable config fragments (`dagclaw.presets/`) for reusable StageDefinition bundles. No separate skills system — memory + custom stages + plan replay cover all use cases. |
| Per-subtask tool scoping | v0.3+ | Planner restricts allowed tools per subtask via `allowedTools` field in SubtaskSchema. |
| Structured memory with tags | v0.3+ | Frontmatter tags in `.dagclaw/memory/*.md`, `--memory-dir` flag, tag-based filtering for context injection. |
| Run comparison / diff | v0.3+ | `dagclaw diff <id1> <id2>` — compare plans, costs, outcomes between two runs. |
| Native Agent Teams integration | v0.3+ | Use Claude Code's built-in swarm as an optional Execute backend |
| Messaging platform integration | v0.3+ | Trigger runs from Slack/Discord/Telegram, receive status updates |
| Heartbeat/cron scheduling | v0.3+ | Useful when managing large worker trees on long-running projects |
| Distributed deployment | v0.4+ | Remote executors for compute-heavy subtasks, worker node management |
| Community tool ecosystem | v0.4+ | Community-contributed stages, presets, integrations |

---

## Risks & Mitigations

- **JSON parsing reliability**: Claude may not always produce valid JSON. Mitigation: extract from fenced code blocks, validate with Zod, retry once on failure.
- **Tree depth explosion**: Recursive decomposition without limits. Mitigation: `MAX_DEPTH` config (default 3).
- **Memory pressure**: Many nodes with large output buffers. Mitigation: ring buffer limits, optionally write full output to disk.
- **Agent SDK limitations**: Concurrent session limits or rate limits unknown. Mitigation: validate early, semaphore controls concurrency.
- **Subprocess cleanup**: Long-running instances must terminate on cancel. Mitigation: abort controller passed to SDK `query()`, `cancelTree()` walks all descendants.
