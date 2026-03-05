# Claw UI — Developer Guide

A reading guide for programmers maintaining this codebase.

## What This Project Does

Claw UI is a CLI orchestration engine that decomposes software engineering tasks into subtasks and runs them through a **Plan → Execute → Verify** pipeline using Claude Code as the backend. It handles parallel execution via DAG scheduling, automatic retries on verification failure, and persistent logging of every run.

## Source Files at a Glance

```
src/
├── cli.ts                 Entry point. Parses args, wires up orchestrator, prints output.
├── taskOrchestrator.ts    The engine. Drives stages, schedules DAGs, handles retries.
├── claudeRunner.ts        Spawns `claude -p` subprocesses, parses output, tracks cost.
├── stageDefinitions.ts    Stage configs: Plan, Execute, Verify. All stage-specific logic lives here.
├── promptBuilder.ts       Template interpolation and snapshot formatting.
├── dependencyResolver.ts  Topological sort for the subtask DAG.
├── taskManager.ts         Lockfile management and task node factory.
├── runLogger.ts           Writes manifests, logs, prompts, and verification results to disk.
├── memoryManager.ts       Reads/writes .claw/memory/ markdown files.
└── types.ts               All interfaces, Zod schemas, and type definitions.
```

## Core Concepts

### PipelineState

A mutable object that flows through every stage. Each stage reads what it needs and writes its output here:

- `plan` — set by Plan stage, read by Execute and Verify
- `subtaskSnapshots` — set by Execute (one per subtask), read by Verify
- `verification` — set by Verify, read by the retry loop
- `memoryContext` — loaded once at the start from `.claw/memory/`
- `skippedIndices` — accumulated by the DAG runner when subtasks fail

### StageDefinition

The key abstraction. Every stage (Plan, Execute, Verify) is defined as a config object with callback functions. The orchestrator never has stage-specific code — it reads these configs and acts generically:

- `contextBuilder` — maps PipelineState → template variables
- `resultHandler` — parses the output file, updates PipelineState, returns display message
- `subtaskExtractor` — (parallel stages only) extracts subtask list from state
- `resultInterpreter` — (verify stages) returns pass/fail + failed indices
- `retryStage` — name of stage to re-run for failed subtasks

### Structured Output via Files

Agents don't return structured data through stdout. Instead:
1. The prompt tells the agent to write JSON to a specific file path (e.g., `.claw/tmp/plan.json`)
2. The agent uses the Write tool to create that file
3. The orchestrator reads and validates the file with a Zod schema

This is more reliable than parsing text output from Claude.

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

### `cli.ts` — Entry Point

Small file. Three responsibilities:
1. `parseArgs()` — converts argv into `CliOptions`
2. `handleRuns()` — `claw runs` subcommand, reads run history from disk
3. `main()` — creates `TaskOrchestrator`, wires callbacks for terminal I/O, calls `run()`

The callbacks (`onStatus`, `onWarning`, `onApprovalRequest`) are how the orchestrator communicates back to the CLI without depending on it.

### `taskOrchestrator.ts` — The Engine

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
- Logs the prompt to disk (for debugging)
- Spawns Claude via `runClaudeCli()`
- Logs usage and raw output
- Calls `stage.resultHandler()` to parse output and update state

Every Claude invocation goes through `runOne`. There are no other paths.

**`runDAG(stage, state, subtasks)`** — parallel execution:
- Creates a `DependencyResolver` from the subtask list
- Loops: get ready subtasks → batch up to maxConcurrency → `Promise.allSettled(runOne)` → mark complete/skipped
- On failure: `markSkipped()` cascades to all downstream dependents

**`retryLoop(stage, state)`** — verification retry:
- Checks `resultInterpreter` for pass/fail
- If failed: looks up `retryStage` from stage config, re-runs failed subtasks, re-verifies
- Repeats up to `maxRetries` times
- All retry results are numbered and preserved on disk

**Utility functions** (pure, exported for testing):
- `formatPlanForDisplay()` — pretty-prints a plan for the terminal
- `detectSharedResourceConflicts()` — warns about parallel npm/pip usage
- `aggregateUsage()` — sums token counts
- `isGitRepo()`, `getFilesModifiedByGit()` — git helpers

### `claudeRunner.ts` — Claude CLI Backend

Pure functions + one async executor. No class.

**`runClaudeCli(options)`** — the core:
- Spawns `claude -p --verbose --output-format stream-json`
- Passes the prompt via stdin
- Collects stdout, parses the last `result` JSON line for usage stats and session ID
- Returns `{rawOutput, sessionId, usage}`

**`buildStagePrompt(template, context)`** — delegates to `interpolateTemplate()`. Replaces `{{key}}` placeholders.

**`parseStageOutput(stageName, raw)`** / **`parseStageOutputFile(stageName, path)`** — validates JSON against the stage's Zod schema. Returns `null` on failure (with stderr logging).

**`estimateCost()`** / **`parseUsageFromCliOutput()`** — token counting and cost estimation using Sonnet 4 pricing.

### `stageDefinitions.ts` — Stage Configs

All stage-specific logic lives here. The orchestrator imports `getStageDefinition(name)` and treats every stage identically.

**Plan stage:**
- System prompt: read-only analysis, decompose into subtasks, evaluate prompt quality
- Allowed tools: Read, Glob, Grep, Write (Write for the output file only)
- `contextBuilder`: maps state → {workDir, prompt, memoryContext, outputFile}
- `resultHandler`: parses plan JSON, sets `state.plan`
- `approvalRequired: true` (unless --auto-approve)

**Execute stage:**
- System prompt: full tool access, complete the subtask, write summary JSON
- `parallel: true` — uses DAG scheduling
- `subtaskExtractor`: pulls subtask list from `state.plan`
- `contextBuilder`: includes plan summary, predecessor context, memory
- `resultHandler`: parses executor output, throws on `success: false` (triggers cascade-skip), otherwise stores ContextSnapshot

**Verify stage:**
- System prompt: review code, run tests, check each subtask
- `contextBuilder`: includes plan summary, all subtask summaries, skipped indices
- `resultHandler`: parses verification result, sets `state.verification`
- `resultInterpreter`: extracts failed indices where `retryRecommended: true`
- `retryStage: "Execute"` — on failure, re-run Execute for failed subtasks
- `maxRetries: 2`

### `promptBuilder.ts` — Prompt Assembly

- `interpolateTemplate(template, context)` — simple `{{key}}` replacement
- `formatSnapshotCompact/Standard()` — formats ContextSnapshots at different detail levels
- `buildPrompt()` — full assembly: memory → snapshots → task prompt (cache-optimized ordering)

### `dependencyResolver.ts` — DAG Scheduler

- `DependencyResolver` class: tracks pending/complete/skipped state per subtask index
  - `getReady()` — returns indices whose dependencies are all complete
  - `markComplete(index)` — marks done
  - `markSkipped(index)` — marks failed, cascades to all downstream dependents
- `detectCircularDependencies()` — DFS cycle detection, returns the cycle or null

### `taskManager.ts` — Lock & Task Factory

- `acquireLock(workDir, runId)` — creates `.claw/lock` with PID. Throws if another instance is running.
- `releaseLock(workDir)` — removes the lock file
- `checkStaleLock(workDir)` — detects lock from a dead process (checks `process.kill(pid, 0)`), cleans up
- `createTaskNode(options)` — factory for TaskNode objects (used in future phases)

### `runLogger.ts` — Persistent Logging

Writes everything to `.claw/runs/<runId>/`:

- `initRun()` — creates directory structure + initial manifest
- `writePlan()` — saves plan JSON
- `appendSubtaskLog()` — streaming output per subtask (appends)
- `appendStageLog()` — raw output for Plan/Verify, numbered by attempt
- `logStagePrompt()` — saves full prompt + system prompt as markdown
- `writeVerification()` — numbered per attempt (verification-0.json, verification-1.json)
- `updateSubtaskUsage()` / `updateStageUsage()` — updates manifest with token counts
- `recalcTotals()` — sums perStage + perSubtask into totals
- `listRuns()` — reads all manifests, returns sorted summaries

### `memoryManager.ts` — Knowledge Injection

Reads `.claw/memory/*.md` files and formats them as a context block injected into prompts:
- `readAll()` — concatenates all markdown files with headers
- `buildContextBlock(maxChars?)` — wraps with `--- Project Memory ---` header, optional truncation
- `writeFile()` / `readFile()` — for future memory distillation

## How to Add a Custom Stage

1. Define a `StageDefinition` object in `stageDefinitions.ts` (or a separate file)
2. Add it to `BUILTIN_STAGES`
3. The stage needs at minimum: `name`, `runnerConfig` (system prompt + template), `contextBuilder`, `resultHandler`
4. For parallel stages: add `parallel: true` and `subtaskExtractor`
5. For stages that check results: add `resultInterpreter` and optionally `retryStage`
6. Use it: `--pipeline "Plan,Execute,YourStage,Verify"`

No changes to the orchestrator needed.

## Testing

```bash
# Unit tests (125 tests, node:test runner)
node --import tsx --test src/__tests__/*.test.ts

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
```

## Key Design Decisions

1. **Stage-agnostic orchestrator** — all stage differences expressed through `StageDefinition` config, not if/else branches
2. **Single execution primitive** — `runOne()` handles both standalone stages and individual subtasks within parallel stages
3. **Structured output via files** — agents write JSON to `.claw/tmp/`, orchestrator validates with Zod. More reliable than parsing stdout.
4. **Data-driven retry** — `retryStage` field on StageDefinition tells the orchestrator what to re-run. No hardcoded stage names in retry logic.
5. **Cascade-skip via throw** — Execute `resultHandler` throws on `success: false`, caught by `Promise.allSettled` in DAG runner, which calls `markSkipped()` to cascade.
6. **Immutable run logs** — every prompt, output, and verification attempt is preserved with numbering. Nothing is overwritten.
