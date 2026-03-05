# Claw UI — System Architecture Plan

## Context

Claw UI is a local web application for orchestrating multiple Claude Code instances through user-defined multi-stage workflows (e.g., Plan → Execute → Verify). Tasks form a recursive tree — a Plan stage can decompose work into subtasks, each potentially spawning its own sub-workflow. The system manages dependency-aware parallel execution across Claude Code instances with real-time UI updates.

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

### 2. Generic ClaudeRunner (`backend/src/services/claudeRunner.ts`)

**The core abstraction.** All stage runners are fundamentally the same thing: a coding agent wrapper with different context. `ClaudeRunner` is a configurable session executor that supports **multiple backends**.

```typescript
// Backend selection — Agent SDK or CLI subprocess (or future: other tools)
type RunnerBackend =
  | { type: "sdk" }                          // Agent SDK: @anthropic-ai/claude-agent-sdk query()
  | { type: "cli"; command?: string }        // CLI: `claude -p --output-format stream-json` (default)
                                              //   command override enables non-Claude tools (e.g., "codex", "aider")

interface ClaudeRunnerConfig {
  // Backend
  backend?: RunnerBackend;          // default: "sdk". Fallback to "cli" if SDK unavailable.

  // Prompt construction
  systemPrompt: string;           // stage-specific instructions + output format
  promptTemplate: string;         // template with {{placeholders}} for runtime data

  // Output handling
  outputSchema?: ZodSchema;       // if set, extract + validate JSON from response
  retryOnParseFailure?: boolean;  // retry once if JSON extraction fails (default true)

  // Execution
  allowedTools?: string[];        // Claude Code tools to allow (default: all)
  workDir?: string;               // override working directory

  // Permissions
  permissionMode?: PermissionMode;  // override per-runner (inherits from TaskNode if not set)

  // Context
  contextSnapshots?: ContextSnapshot[];  // injected from DAG predecessors + parent stage
  resumeSessionId?: string;              // only for retrying the SAME subtask
}

interface ClaudeRunnerResult {
  rawOutput: string;              // full text response
  structuredOutput?: any;         // parsed JSON if outputSchema was provided
  sessionId: string;              // for retrying THIS task only (not for chaining)
  contextSnapshot: ContextSnapshot; // auto-generated snapshot for downstream tasks
  messages: SDKMessage[];         // all streamed messages
  usage: UsageStats;              // token usage and cost tracking
}

interface UsageStats {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  estimatedCost: number;          // USD estimate based on model pricing
  durationMs: number;
}

class ClaudeRunner {
  constructor(private config: ClaudeRunnerConfig) {}

  async run(context: Record<string, string>): AsyncGenerator<SDKMessage, ClaudeRunnerResult> {
    // 1. Interpolate {{placeholders}} in promptTemplate with context values
    // 2. Dispatch to backend:
    //    - "sdk": call Agent SDK query() with systemPrompt + interpolated prompt
    //    - "cli": spawn `claude -p --output-format stream-json` (or custom command) as subprocess
    // 3. Yield each message as it streams
    // 4. If outputSchema set: extract JSON, validate with Zod
    // 5. On parse failure + retryOnParseFailure: send follow-up asking to fix JSON
    // 6. Collect usage stats from SDK response or CLI JSON output
    // 7. Return ClaudeRunnerResult with usage
  }
}
```

**Backend selection logic:**
- Default: Agent SDK (`"sdk"`). Structured, typed, recommended.
- Fallback: CLI (`"cli"`). Uses `claude -p --output-format stream-json`. No API key needed — uses Claude Code's own auth. Set via `--backend cli` flag or in config.
- Custom: `{ type: "cli", command: "codex" }` or any CLI tool that accepts a prompt on stdin and outputs to stdout. This enables users to swap in alternative coding agents.

**Context flow via snapshots:**
Each subtask produces a `ContextSnapshot` on completion. The orchestrator injects predecessor snapshots into dependent subtasks' prompts via the `contextSnapshots` field. This enables clean parallel forking (all Execute subtasks inherit Plan's snapshot) and DAG accumulation (dependent subtasks get all predecessors' snapshots). See the "Context Management" section for full details.

### 3. Stage Definitions (`backend/src/services/stageDefinitions.ts`)

Built-in stages are just pre-configured `ClaudeRunnerConfig` objects. Users can define custom stages the same way.

```typescript
interface StageDefinition {
  name: string;                        // "Plan", "Execute", "Verify", or custom
  runnerConfig: ClaudeRunnerConfig;    // the Claude Code configuration

  // Stage behavior hooks (optional)
  approvalRequired?: boolean;          // pause for user approval after completion
  parallel?: boolean;                  // if true, run multiple instances (Execute-style)

  // For parallel stages: how to derive subtask list from prior stage output
  subtaskExtractor?: (priorOutput: any) => SubtaskDefinition[];

  // For verification stages: how to interpret output as pass/fail
  resultInterpreter?: (output: any) => { pass: boolean; failedIndices?: number[] };

  // Max retries if resultInterpreter returns pass=false
  maxRetries?: number;
}
```

**Built-in stage definitions:**

```typescript
const BUILTIN_STAGES: Record<string, StageDefinition> = {
  Plan: {
    name: "Plan",
    runnerConfig: {
      systemPrompt: "You are a planning agent. Decompose the task into subtasks...",
      promptTemplate: "Working directory: {{workDir}}\nTask: {{prompt}}",
      outputSchema: PlanSchema,  // Zod schema for Plan type
      allowedTools: ["Read", "Glob", "Grep"],  // read-only for planning
    },
    approvalRequired: true,  // default, overridable per task
  },

  Execute: {
    name: "Execute",
    runnerConfig: {
      systemPrompt: "You are an execution agent. Complete the assigned subtask...",
      promptTemplate: "Working directory: {{workDir}}\nTask: {{subtaskPrompt}}\nContext: {{planSummary}}",
      allowedTools: ["Read", "Edit", "Write", "Bash", "Glob", "Grep"],
    },
    parallel: true,
    subtaskExtractor: (planOutput) => planOutput.subtasks,
  },

  Verify: {
    name: "Verify",
    runnerConfig: {
      systemPrompt: "You are a verification agent. Review the execution results...",
      promptTemplate: "Plan: {{plan}}\nExecution results: {{executionOutput}}\nVerify correctness.",
      outputSchema: VerificationResultSchema,
      allowedTools: ["Read", "Bash", "Glob", "Grep"],  // can run tests, read files
    },
    resultInterpreter: (output) => ({
      pass: output.overallPass,
      failedIndices: output.subtaskResults.filter(r => !r.pass && r.retryRecommended).map(r => r.subtaskIndex),
    }),
    maxRetries: 3,
  },
};
```

**User-defined custom stages** follow the exact same shape:

```typescript
// Example: user defines a "Test" stage and a "Review" stage
const customStages: StageDefinition[] = [
  {
    name: "Test",
    runnerConfig: {
      systemPrompt: "You are a testing agent. Write and run tests for the implemented code.",
      promptTemplate: "Working directory: {{workDir}}\nCode changes: {{executionOutput}}\nWrite comprehensive tests.",
      outputSchema: TestResultSchema,
      allowedTools: ["Read", "Write", "Bash", "Glob", "Grep"],
    },
    resultInterpreter: (output) => ({ pass: output.allTestsPassed }),
    maxRetries: 2,
  },
  {
    name: "SecurityAudit",
    runnerConfig: {
      systemPrompt: "You are a security auditor. Review code for vulnerabilities...",
      promptTemplate: "Working directory: {{workDir}}\nReview all changes for OWASP top 10 vulnerabilities.",
      outputSchema: AuditResultSchema,
      allowedTools: ["Read", "Grep", "Glob"],
    },
    approvalRequired: true,  // human reviews security findings
  },
];

// User's pipeline: ["Plan", "Execute", "Test", "SecurityAudit", "Verify"]
```

### 4. Stage Resolution in TaskOrchestrator

The orchestrator resolves each stage name to a `StageDefinition`, then uses the generic logic:

```
for each stageName in pipeline:
  definition = resolveStage(stageName)  // built-in or user-defined

  if definition.parallel && definition.subtaskExtractor:
    subtasks = definition.subtaskExtractor(previousStageOutput)
    run DAG-based parallel execution via ClaudeRunner instances
  else:
    run single ClaudeRunner with definition.runnerConfig

  if definition.resultInterpreter:
    result = definition.resultInterpreter(output)
    if !result.pass: retry failed subtasks up to definition.maxRetries

  if definition.approvalRequired && !node.autoApprove:
    pause, await approval
```

This means **PlanRunner, ExecuteRunner, and VerifyRunner are no longer separate classes**. They are just different `StageDefinition` configs processed by the same orchestrator logic. The orchestrator itself handles the parallel dispatch, retry loops, and approval gates based on the definition's flags.

### 5. DependencyResolver (`backend/src/services/dependencyResolver.ts`)

Topological sort utility for the subtask DAG (used by any stage with `parallel: true`):
- `getReady()` — returns subtasks whose dependencies are all complete
- `markComplete(index)` — marks a subtask done
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
npx claw "Build the Express + WebSocket backend server for Claw UI per PLAN.md"
```
and it Plans → Executes → Verifies autonomously.

---

### Phase 0: Bootstrap CLI (built by Claude Code directly)

**Goal**: Minimal CLI that runs a single Plan → Execute → Verify workflow. No web UI, no REST API, no WebSocket. Just the orchestration engine with terminal output. Built by Claude Code in a standard coding flow — the foundation everything else bootstraps from.

**Files to create (all under `src/`):**

```
claw_ui/
├── src/
│   ├── cli.ts                    # CLI entry: parse args, run orchestrator, print to terminal
│   ├── types.ts                  # Core types (TaskNode, StageDefinition, ClaudeRunnerConfig, Plan, etc.)
│   ├── claudeRunner.ts           # Generic Claude Code wrapper
│   ├── stageDefinitions.ts       # Built-in Plan/Execute/Verify configs
│   ├── dependencyResolver.ts     # DAG topological sort
│   ├── taskOrchestrator.ts       # Pipeline driver (single workflow, sequential stages)
│   ├── taskManager.ts            # Minimal: just creates/tracks nodes, no REST
│   ├── runLogger.ts              # Persistent run logging to .claw/runs/
│   └── memoryManager.ts          # Distill memory from run logs, inject into future runs
├── package.json                  # deps: @anthropic-ai/claude-agent-sdk, zod, uuid
├── tsconfig.json
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

**CLI output** — structured terminal output (no xterm.js needed, just console):
```
[Plan] Starting plan stage...
[Plan] Claude is analyzing the task...
[Plan] Plan generated: 3 subtasks
  ├── [0] Set up Express routes (low complexity)
  ├── [1] Implement WebSocket server (medium complexity, depends on 0)
  └── [2] Wire up task manager (low complexity, depends on 0)
[Plan] Approve this plan? (y/n/edit): y

[Execute] Starting execution...
[Execute] [0] Set up Express routes — running...
[Execute] [2] Wire up task manager — waiting for [0]
[Execute] [0] Set up Express routes — completed ✓
[Execute] [1] Implement WebSocket server — running...
[Execute] [2] Wire up task manager — running...
[Execute] [2] Wire up task manager — completed ✓
[Execute] [1] Implement WebSocket server — completed ✓

[Verify] Starting verification...
[Verify] Subtask 0: ✓ pass
[Verify] Subtask 1: ✓ pass
[Verify] Subtask 2: ✗ fail — missing error handler
[Verify] Re-executing subtask 2 (attempt 1/3)...
[Execute] [2] Wire up task manager — running...
[Execute] [2] Wire up task manager — completed ✓
[Verify] Re-verifying...
[Verify] All subtasks: ✓ pass
[Verify] Integration: ✓ pass

✓ Task completed successfully.

[Cost] Total: ~$0.42 | Tokens: 18.2k in / 12.1k out | Duration: 3m 24s
  ├── [Plan]    $0.08  (4.1k in / 2.3k out)
  ├── [Execute] $0.28  (10.5k in / 8.1k out)  ← 3 subtasks
  └── [Verify]  $0.06  (3.6k in / 1.7k out)
```

**Plan approval in CLI**: When `--auto-approve` is not set, the CLI prints the plan and prompts `Approve? (y/n/edit)`. On `n`, it aborts. On `edit`, it opens the plan JSON in `$EDITOR` and re-reads it. On `y`, it continues.

**What's intentionally deferred:**
- No recursive decomposition yet (subtasks with `needsRecursiveDecomposition` just execute directly)
- No web UI, REST, or WebSocket
- No custom stage registration (only built-in Plan/Execute/Verify)
- No ring buffers or subscription management

---

### Phase 0.5: Validate Bootstrap (hand-verified)

Test the CLI on a trivial task to confirm it works end-to-end:
```bash
npx claw --workdir /tmp/test-project "Create a hello world Express server with TypeScript"
```
Verify: plan is generated, subtasks execute, verification passes.

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
   custom StageDefinitions in a claw.config.json file in their project
   root. The CLI should load these and make them available in --pipeline.
   Refer to PLAN.md section 'Stage Definitions' for the StageDefinition
   interface."
```

---

### Phase 3: Use `claw` to build — Backend Server

```bash
npx claw --workdir . \
  "Build the Express + WebSocket backend server for Claw UI.
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
  "Build the React + Vite frontend for Claw UI.
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
  "Polish the Claw UI application:
   1. Add error handling for SDK failures, WebSocket disconnects, reconnection logic
   2. Add cancellation propagation (cancel root → cancel all descendants)
   3. Add concurrency tuning (MAX_CONCURRENT_INSTANCES env var)
   4. Responsive frontend layout
   5. Update CLAUDE.md with dev commands
   6. Update README.md with setup and usage instructions"
```

---

### Summary: What's hand-written vs. self-built

| Component | How it's built |
|-----------|---------------|
| Core types (`types.ts`) | Claude Code direct (Phase 0) |
| `ClaudeRunner` | Claude Code direct (Phase 0) |
| Built-in stage definitions | Claude Code direct (Phase 0) |
| `DependencyResolver` | Claude Code direct (Phase 0) |
| `TaskOrchestrator` (basic) | Claude Code direct (Phase 0) |
| `TaskManager` (minimal) | Claude Code direct (Phase 0) |
| CLI entry point | Claude Code direct (Phase 0) |
| Recursive decomposition | Built by claw (Phase 1) |
| Custom stage support | Built by claw (Phase 2) |
| Express + WebSocket backend | Built by claw (Phase 3) |
| React frontend | Built by claw (Phase 4) |
| Polish & integration | Built by claw (Phase 5) |

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
| Persistent run logs from v0.1.0 | `.claw/runs/` with manifest + per-subtask logs | History available from day one; web viewer reuses same components later |
| Memory distilled from logs | `.claw/memory/` is derived, `.claw/runs/` is source of truth | Raw logs for accountability, memory for evolving intelligence; user can edit both |
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
.claw/
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
The frontend adds a "Run History" view that reads from `.claw/runs/`. Each run is expandable to show the full task tree, plan, subtask outputs (rendered in xterm.js for ANSI support), and verification results. This reuses the same `TaskTreeView` and `SubtaskTerminal` components — they just read from disk instead of a live WebSocket.

### Retention
- Default: keep last 50 runs (configurable in `.claw/config.json`)
- Oldest runs auto-pruned on new run start
- `npx claw runs --clean` to manually prune

---

## Persistent Memory (Distilled from Run Logs)

Memory is a **derived layer** on top of raw run logs — not a replacement. Raw logs are the source of truth for accountability; memory is the distilled, evolving knowledge that makes future runs smarter.

### How it works

```
Raw logs (.claw/runs/)          Memory (.claw/memory/)
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
.claw/
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

2. **Before each run starts**, the orchestrator reads `.claw/memory/` and injects relevant content into the Claude Code instances' system context. The Plan stage gets all memory (to inform decomposition); Execute subtasks get memory relevant to their scope.

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
The frontend adds a "Memory" panel where users can browse and edit `.claw/memory/` files. Shows when each entry was last updated and which run it originated from.

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
┌─────────────────────────────┐
│ System prompt                │ ← identical across ALL subtasks (always cached)
│ Memory (.claw/memory/)       │ ← identical within a run (cached after 1st subtask)
│ Plan snapshot                │ ← identical for all Execute subtasks (cached)
├─────────────────────────────┤  ← cache breaks here
│ Predecessor snapshots        │ ← varies per subtask
│ Subtask-specific prompt      │ ← unique
└─────────────────────────────┘
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
- Injects memory from `.claw/memory/` for accumulated learnings
- Pre-populates the DAG state — completed subtasks keep their snapshots, failed subtask gets a fresh start

This gives users a natural "pick up where I left off" workflow.

---

## Future Roadmap (post v0.1.0)

Features identified but explicitly deferred:

| Feature | Version | Notes |
|---------|---------|-------|
| Advanced context management | v0.2+ | Relevance scoring (file overlap), on-demand context tool, context compression for deep DAGs, toxicity detection |
| Git worktree isolation | v0.2+ | Optional per-subtask worktree for conflict-free parallel execution |
| CI integration | v0.2+ | Trigger a templated task pipeline on CI failure (just another task, no special handling) |
| Shareable skill packs (`claw.skills/`) | v0.2+ | Reusable StageDefinition presets, shareable across projects |
| Native Agent Teams integration | v0.3+ | Use Claude Code's built-in swarm as an optional Execute backend |
| Messaging platform integration | v0.3+ | Trigger runs from Slack/Discord/Telegram, receive status updates |
| Heartbeat/cron scheduling | v0.3+ | Useful when managing large worker trees on long-running projects |
| Distributed deployment | v0.4+ | Remote executors for compute-heavy subtasks, worker node management |
| Community tool ecosystem | v0.4+ | Community-contributed stages, skill packs, integrations |

---

## Risks & Mitigations

- **JSON parsing reliability**: Claude may not always produce valid JSON. Mitigation: extract from fenced code blocks, validate with Zod, retry once on failure.
- **Tree depth explosion**: Recursive decomposition without limits. Mitigation: `MAX_DEPTH` config (default 3).
- **Memory pressure**: Many nodes with large output buffers. Mitigation: ring buffer limits, optionally write full output to disk.
- **Agent SDK limitations**: Concurrent session limits or rate limits unknown. Mitigation: validate early, semaphore controls concurrency.
- **Subprocess cleanup**: Long-running instances must terminate on cancel. Mitigation: abort controller passed to SDK `query()`, `cancelTree()` walks all descendants.
