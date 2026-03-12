# DAGClaw — Call Graph & Data Flow

## High-Level Pipeline Flow

```
┌─────────┐     CliOptions       ┌──────────────────┐
│  cli.ts │ ──────────────────→  │ TaskOrchestrator │
│         │     callbacks:       │                  │
│ parseArgs()  {onStatus,        │  run()           │
│ main()  │    onWarning,        │  ├→ Plan stage   │
│ askYesNo()   onApproval,       │  ├→ Execute DAG  │
│         │    onDAGEvent,       │  ├→ Verify stage │
│         │    onStageStart,     │  └→ retryLoop()  │
│         │    onStageEnd}       │                  │
│         │ ←─── string msgs ──  │                  │
└────┬────┘                      └────────┬─────────┘
     │                                    │
     │  ┌──────────────┐                  │
     └─→│  DagDisplay  │←── DAGEvent ─────┘
        │              │    (dag-start, subtask-started,
        │ handleEvent()│     subtask-completed, etc.)
        │ stageStart() │
        │ writeStatus()│    Renders live TTY status
        └──────────────┘    or sequential non-TTY lines
                                          │
                    ┌────────────────────┬┴──────────────────┬─────────────────┐
                   ▼                    ▼                    ▼                 ▼
           ┌──────────────┐  ┌──────────────────┐  ┌──────────────┐  ┌────────────────┐
           │ claudeRunner │  │ stageDefinitions │  │  runLogger   │  │ memoryManager  │
           │              │  │                  │  │              │  │                │
           │ runClaudeCli │  │ BUILTIN_STAGES   │  │ initRun()    │  │ readAll()      │
           │ buildStage   │  │ Plan/Execute/    │  │ logPrompt()  │  │ buildContext   │
           │   Prompt()   │  │ Verify configs   │  │ writeVerify()│  │   Block()      │
           │ extractText  │  │                  │  │ writeRun     │  │ writeFile()    │
           │  FromStream  │  │                  │  │   Memory()   │  │ updateIndex()  │
           │  Json()      │  │                  │  │              │  │                │
           └──────┬───────┘  └──────────────────┘  └──────┬───────┘  └───────┬────────┘
                  │                                       │                  │
                  ▼                                       │                  │
        ┌─────────────────┐  ┌──────────────────┐        │                  │
        │ claude -p (CLI) │  │ memoryDistiller  │←───────┴──────────────────┘
        │ subprocess      │  │ distillMemory()  │  (uses logger + memoryManager
        └─────────────────┘  └──────────────────┘   after run completion)
                                               ┌─────────────────────┐
                                               │ .dagclaw/              │
                                               │ ├── runs/<id>/      │
           ┌───────────────────┐               │ ├── tmp/            │
           │ dependencyResolver│               │ ├── memory/         │
           │ DependencyResolver│               │ └── lock            │
           │ detectCircularDeps│               └─────────────────────┘
           └───────────────────┘
           ┌──────────────┐
           │ taskManager  │
           │ acquireLock  │
           │ releaseLock  │
           │ checkStale   │
           └──────────────┘
```

## Detailed `run()` Sequence — Data Packets at Each Step

**Pre-run (before orchestrator construction):**
```
cli.ts main() / taskStore.ts startTask():
│
├─ loadAndMergeStages(projectDir)            (configLoader.ts)
│     ├─ loadCustomStages(projectDir)
│     │   ├─ IF dagclaw.config.ts exists: dynamic import, validate each stage
│     │   └─ ELIF dagclaw.config.json exists: JSON.parse + DagClawConfigSchema (Zod)
│     │       → JSON stages get default contextBuilder (all string PipelineState fields)
│     │       → JSON stages get default resultHandler (reads .summary/.message)
│     └─ mergeStages(BUILTIN_STAGES, custom)
│         → reserved names (Plan, Execute, Verify) require overrideBuiltin: true
│         → returns merged stage registry
│
├─ Validate pipeline stages against registry
│     → throws if any pipeline stage not found in registry
│
└─ new TaskOrchestrator(opts, callbacks, 0, logger, stageRegistry)
```

```
TaskOrchestrator.run()
│
├─ 1. IF !isChild: checkStaleLock(workDir)
│     → returns {runId: string, pid: number} | null
│
├─ 2. IF backend.type === 'cli': checkClaudeCli()
│     → throws if claude binary not found
│
├─ 3. captureGitInfo()
│     → returns {branch, commitBefore, commitAfter: null, filesModified: []}
│
├─ 4. logger.initRun(InitRunOptions)
│     │  ┌─ InitRunOptions ──────────────────────────────┐
│     │  │ prompt: string                                │
│     │  │ pipeline: ["Plan", "Execute", "Verify"]       │
│     │  │ backend: "cli"                                │
│     │  │ permissionMode: "auto" | "interactive" | ...  │
│     │  │ gitInfo?: {branch, commitBefore, ...}         │
│     │  │ taskNumber?: number                           │
│     │  └───────────────────────────────────────────────┘
│     → returns runId: string
│     → creates .dagclaw/runs/<runId>/manifest.json
│
├─ 5. IF !isChild: acquireLock(workDir, runId)
│     → creates .dagclaw/lock {pid, runId, startedAt}
│
├─ 6. memory.buildContextBlock()
│     → reads .dagclaw/memory/*.md
│     → returns "--- Project Memory ---\n### file.md\n<content>\n..."
│
├─ 7. Build PipelineState (mutable, flows through all stages)
│     ┌─ PipelineState ──────────────────────────────────────┐
│     │ prompt: string                                       │
│     │ workDir: string                                      │
│     │ plan: Plan | null            ← set by Plan stage     │
│     │ subtaskSnapshots: Map<number, ContextSnapshot>       │
│     │                              ← set by Execute stage  │
│     │ skippedIndices: Set<number>  ← set by DAG runner     │
│     │ memoryContext: string        ← from MemoryManager    │
│     │ verification: VerResult|null ← set by Verify stage   │
│     │ dagPalette: string[]         ← from CliOptions       │
│     │ postStages: string[]         ← derived from pipeline │
│     │ stageDescriptions: string    ← formatted palette     │
│     └──────────────────────────────────────────────────────┘
│
├─ 8. FOR EACH stage in pipeline:
│     │
│     ├─ getStageDefinition(stageName, stageRegistry?)
│     │    → returns StageDefinition (from registry or BUILTIN_STAGES)
│     │
│     ├─ IF stage.parallel && stage.subtaskExtractor:
│     │    subtasks = stage.subtaskExtractor(state)
│     │    → runDAG(runId, stage, state, subtasks)
│     │
│     ├─ ELSE:
│     │    → runOne(runId, stage, state)
│     │
│     ├─ IF stage.approvalRequired && !autoApprove:
│     │    → requestApproval(stage, state)
│     │
│     └─ IF stage.resultInterpreter && state.verification:
│          → retryLoop(runId, stage, state)
│
├─ 9. logger.updateManifestStatus(runId, "completed" | "failed")
├─ 10. IF !noSummary: printCostSummary(runId)
├─ 11. IF plan.worthDistilling && !noMemory:
│       distillMemory(runId, state, logger, memoryManager, opts)
│       → runs Claude distiller, extracts clean text from NDJSON
│       → writes to per-run memory.md + project-level <runId>.md
│       → regenerates .dagclaw/memory/index.md
│       (non-fatal: errors logged but don't fail the pipeline)
└─ 12. IF !isChild: releaseLock(workDir)
```

## `runOne()` — Single Execution Primitive

Every Claude invocation flows through this method.

```
runOne(runId, stage, state, subtask?)
│
├─ 1. Compute output file path (run-scoped tmp)
│     subtask? → ".dagclaw/runs/<runId>/tmp/subtask-{N}-summary.json"
│     stage    → ".dagclaw/runs/<runId>/tmp/{stage}.json"
│
├─ 2. stage.contextBuilder(state, outputFile, subtask?)
│     │
│     │  Plan returns:
│     │  ┌──────────────────────────────────────────────────────┐
│     │  │ workDir: "/path/to/project"                          │
│     │  │ prompt: "Build a CLI tool..."                        │
│     │  │ memoryContext: "--- Memory ---\n..."                 │
│     │  │ outputFile: ".dagclaw/runs/<id>/tmp/plan.json"          │
│     │  │ dagPaletteDescriptions: "- Execute: ... (tools: all)"│
│     │  │ postStagesDescription: "- Verify"                    │
│     │  └──────────────────────────────────────────────────────┘
│     │
│     │  Execute returns:
│     │  ┌────────────────────────────────────────────────────────┐
│     │  │ workDir: "/path/to/project"                            │
│     │  │ subtaskPrompt: "Create math.js with add..."            │
│     │  │ planSummary: "Build 3-file project..."                 │
│     │  │ predecessorContext: "Predecessor subtask summaries:\n" │
│     │  │   "[Subtask 0] Created Express app with routes"        │
│     │  │   (built from subtask.dependencies → subtaskSnapshots) │
│     │  │ memoryContext: "--- Memory ---\n..."                   │
│     │  │ outputFile: ".dagclaw/runs/<id>/tmp/subtask-0-summary.json" │
│     │  └────────────────────────────────────────────────────────┘
│     │
│     │  Verify returns:
│     │  ┌──────────────────────────────────────────────┐
│     │  │ workDir: "/path/to/project"                  │
│     │  │ planSummary: "Build 3-file project..."       │
│     │  │ subtaskSummaries: "[Subtask 0] Created..."   │
│     │  │ skippedIndices: "none" | "1, 2"              │
│     │  │ outputFile: ".dagclaw/runs/<id>/tmp/verify.json" │
│     │  └──────────────────────────────────────────────┘
│     │
│     → returns Record<string, string>  (template variables)
│
├─ 3. buildStagePrompt(template, context) — for BOTH systemPrompt AND promptTemplate
│     │  interpolates {{placeholders}} (e.g., {{dagPaletteDescriptions}})
│     → returns assembled prompt string
│
├─ 4. logger.logStagePrompt(runId, stageName, prompt, systemPrompt, subtaskIndex?)
│     → writes .dagclaw/runs/<id>/prompts/{stage}.md
│        (retry-numbered: verify-retry-1.md, execute-subtask-1-retry-1.md)
│
├─ 5. runClaudeCli(RunClaudeOptions)
│     ┌─ RunClaudeOptions ───────────────────────────────────┐
│     │ prompt: string           (assembled prompt)          │
│     │ systemPrompt: string     (stage system prompt)       │
│     │ workDir: string                                      │
│     │ allowedTools: ["Read","Glob","Grep","Write"] | ...   │
│     │ timeoutMs: 300000                                    │
│     │ backend: {type: "cli"}                               │
│     │ dangerouslySkipPermissions: true                     │
│     └──────────────────────────────────────────────────────┘
│     │
│     │  Spawns: claude -p --verbose --output-format stream-json
│     │          --allowedTools Read --allowedTools Glob ...
│     │          --dangerously-skip-permissions
│     │          --system-prompt "..."
│     │  stdin ← prompt
│     │  stdout → collects stream-json lines
│     │
│     │  Parses last "result" line for usage + sessionId
│     │
│     → returns RunClaudeResult
│       ┌─ RunClaudeResult ─────────────────────────┐
│       │ rawOutput: string   (full stdout)         │
│       │ sessionId: string   (from result line)    │
│       │ usage: UsageStats                         │
│       │   ┌─ UsageStats ──────────────────────┐   │
│       │   │ inputTokens: 7522                 │   │
│       │   │ outputTokens: 3107                │   │
│       │   │ cacheReadTokens: 67348            │   │
│       │   │ cacheCreationTokens: 10635        │   │
│       │   │ estimatedCost: 0.129              │   │
│       │   └───────────────────────────────────┘   │
│       └───────────────────────────────────────────┘
│
├─ 6. Log usage + raw output
│     subtask → logger.updateSubtaskUsage(runId, index, usage)
│               logger.appendSubtaskLog(runId, index, rawOutput)
│     stage   → logger.updateStageUsage(runId, stageName, usage)
│               logger.appendStageLog(runId, stageName, rawOutput)
│
├─ 7. Validate structured output via declared schema
│     IF stage.outputSchema:
│       parsedOutput = parseStageOutputFile(stage.outputSchema, outputFile)
│       → reads file, validates JSON via Zod schema
│       → returns parsed object or null on failure
│     ELSE:
│       parsedOutput = null
│
└─ 8. stage.resultHandler(state, parsedOutput, subtask?, sessionId)
      │  Receives already-validated data — no file I/O or parsing needed.
      │
      │  Plan handler:
      │    → receives Plan object (validated via PlanSchema)
      │    → runs detectCircularDependencies, detectSharedResourceConflicts
      │    → sets state.plan
      │    → returns "[Plan] Generated plan: 3 subtask(s) — ..."
      │
      │  Execute handler:
      │    → receives ExecutorOutput (validated via ExecutorOutputSchema)
      │    → IF success=false: throws Error (triggers cascade-skip in DAG)
      │    → sets state.subtaskSnapshots.set(index, ContextSnapshot)
      │    → returns "[Execute] [0] Done: Add math.js module"
      │
      │  Verify handler:
      │    → receives VerificationResult (validated via VerificationResultSchema)
      │    → sets state.verification
      │    → returns "[Verify] All checks passed." or "[Verify] Failed subtasks: 1"
      │
      → returns display message: string
```

## `runDAG()` — Parallel Execution with Dependency Resolution

```
runDAG(runId, stage, state, subtasks: SubtaskDefinition[])
│
├─ emitDAG({type: 'dag-start', subtasks: [...]})
│
├─ DependencyResolver(subtasks)
│    internally builds:
│    ┌─ state per index ───────────────────────┐
│    │ 0: {deps: [],    status: "pending"}     │
│    │ 1: {deps: [],    status: "pending"}     │
│    │ 2: {deps: [0,1], status: "pending"}     │
│    └─────────────────────────────────────────┘
│
├─ Greedy scheduler (Promise.race, not batched):
│    │
│    ├─ tryLaunch():
│    │   WHILE running.size < maxConcurrency && !shuttingDown:
│    │     ready = resolver.getReady().filter(not already running)
│    │     IF empty: break
│    │     idx = ready[0]
│    │
│    │     Per-subtask stage resolution:
│    │       subtask.stage? → getStageDefinition(subtask.stage, registry)
│    │       else           → use parent stage (Execute)
│    │
│    │     emitDAG({type: 'subtask-started', index})
│    │
│    │     executeSubtask(idx) — with per-subtask retry:
│    │       FOR attempt = 1..maxAttempts (opts.maxSubtaskRetries + 1):
│    │         try runOne or runRecursive
│    │         on retryable error (ClaudeRunError or SubtaskError.retryWorthy):
│    │           emitDAG({type: 'subtask-retrying', index, attempt, maxAttempts})
│    │           continue
│    │         on exhaustion:
│    │           emitDAG({type: 'subtask-retry-exhausted', index, attempts})
│    │           throw
│    │
│    │     .then → resolver.markComplete(idx)
│    │            emitDAG({type: 'subtask-completed', index, oneliner, elapsed})
│    │     .catch → emitDAG({type: 'subtask-failed', index, error, elapsed})
│    │              cascaded = resolver.markSkipped(idx)
│    │              state.skippedIndices.add(idx)
│    │              FOR each cascadedIdx:
│    │                state.skippedIndices.add(cascadedIdx)
│    │                emitDAG({type: 'subtask-skipped', index: cascadedIdx, cascadeFrom: idx})
│    │     .finally → running.delete(idx); tryLaunch()
│    │
│    │     running.set(idx, promise)
│    │
│    ├─ tryLaunch()  ← initial call fills slots
│    │
│    └─ WHILE running.size > 0:
│         await Promise.race(running.values())
│
│  emitDAG({type: 'dag-complete'})
│
│  Example (3 subtasks, diamond dep, maxConcurrency=2):
│    tryLaunch: ready=[0,1] → launch both → running={0,1}
│    Promise.race → 0 completes → tryLaunch: ready=[2] but 1 still running → running={1,2}
│    Promise.race → 1 completes → tryLaunch: nothing ready → running={2}
│    Promise.race → 2 completes → running={} → exit
```

## `retryLoop()` — Verify Failure → Re-Execute → Re-Verify

```
retryLoop(runId, verifyStage, state)
│
├─ FOR attempt = 0..maxRetries:
│    │
│    ├─ verifyStage.resultInterpreter(state.verification)
│    │   → {pass: boolean, failedIndices: number[]}
│    │
│    ├─ IF pass → return true
│    │
│    ├─ logStageFailure() — prints subtask/integration details
│    │
│    ├─ IF no retryStage OR no failedIndices OR attempt >= max:
│    │   → return false
│    │
│    ├─ Resolve retryStage = getStageDefinition("Execute")
│    │   retrySubtasks = subtaskExtractor(state)
│    │     .filter(s => failedIndices.includes(s.index))
│    │
│    ├─ FOR each retrySubtask:
│    │   runOne(runId, executeStage, state, subtask)
│    │   → re-runs Claude for that subtask
│    │   → updates state.subtaskSnapshots
│    │
│    ├─ state.verification = null
│    ├─ runOne(runId, verifyStage, state)
│    │   → re-runs Verify with updated snapshots
│    │   → sets state.verification
│    │
│    └─ logger.writeVerification(runId, result)
│         → verification-0.json, verification-1.json, ...
```

## `runRecursive()` — Child Orchestrator Spawning

```
runRecursive(runId, stage, state, subtask)
│
├─ 1. shouldRecurse(subtask.index, state.plan)
│     → true (needsRecursiveDecomposition flag set by planner)
│
├─ 2. buildChildOptions(parentOpts, planSubtask, depth)
│     → CliOptions with:
│       prompt = subtask.prompt
│       autoApprove = true, noSummary = true
│       maxDepth = parentOpts.maxDepth (unchanged)
│       depth check: throws if depth >= maxDepth
│
├─ 3. logger.createChildLogger(runId)
│     → RunLogger with parentRunDir = runs/<parentRunId>/
│     → child runs go to runs/<parentRunId>/children/<childRunId>/
│
├─ 4. new TaskOrchestrator(childOpts, filteredCallbacks, depth+1, childLogger, stageRegistry)
│     → strips onDAGEvent, onStageStart, onStageEnd from parent callbacks
│     → isChild = true (skips lock management)
│
├─ 5. child.run()
│     → runs full Plan → Execute → Verify pipeline
│     → logs to nested directory
│     → returns {runId, success}
│
├─ 6. IF !success: throw Error (triggers cascade-skip in parent DAG)
│
└─ 7. Store ContextSnapshot in state.subtaskSnapshots
      → downstream subtasks can reference recursive subtask output
```

## Structured Output Schemas (Zod)

Agents write JSON to run-scoped tmp dirs (`.dagclaw/runs/<runId>/tmp/`). The orchestrator's `runOne()` validates via each stage's declared `outputSchema` (Zod), then passes parsed data to `resultHandler`:

### Plan Output (`plan.json`)
```json
{
  "summary": "string",
  "subtasks": [
    {
      "index": 0,
      "description": "string",
      "prompt": "string",
      "dependencies": [1, 2],
      "estimatedComplexity": "low" | "medium" | "high",
      "needsRecursiveDecomposition": false,
      "stage": "Execute"
    }
  ],
  "qualityFlag": {"concern": "vague", "message": "...", "suggestion": "..."} | null,
  "worthDistilling": true | false
}
```

### Executor Output (`subtask-N-summary.json`)
```json
{
  "success": true | false,
  "summary": "paragraph describing what was done",
  "oneliner": "one-line description",
  "retryWorthy": false
}
```

### Verification Output (`verify.json`)
```json
{
  "overallPass": true | false,
  "subtaskResults": [
    {"subtaskIndex": 0, "pass": true, "summary": "...", "retryRecommended": false}
  ],
  "skippedIndices": [1, 2],
  "integrationResult": {"pass": true, "summary": "...", "issues": []}
}
```

## Memory Management — Complete Dataflow

Memory is DAGClaw's cross-run learning system. It reads distilled knowledge from past runs into
every stage prompt, and writes new knowledge after successful runs. Two tiers: **project-level**
(shared across runs) and **per-run** (audit trail per execution).

### Architecture Overview

```
                          ┌─────────────────────────────────────────────┐
                          │           .dagclaw/memory/                  │
                          │  ┌──────────┐  ┌──────────┐  ┌──────────┐  │
                          │  │ index.md │  │ runA.md  │  │ runB.md  │  │
                          │  │ (table)  │  │ (detail) │  │ (detail) │  │
                          │  └────┬─────┘  └────┬─────┘  └────┬─────┘  │
                          │       │             │             │        │
                          └───────┼─────────────┼─────────────┼────────┘
                                  │             │             │
                    ┌─────────────┴─────────────┴─────────────┘
                    │ readAll() → sortFilesIndexFirst()
                    │ → concatenate with ### headers
                    ▼
            ┌───────────────┐     buildContextBlock()     ┌──────────────────┐
            │ MemoryManager │ ──────────────────────────→ │ PipelineState    │
            │               │  "--- Project Memory ---"   │ .memoryContext   │
            └───────┬───────┘  "### index.md\n..."        └────────┬─────────┘
                    │          "### <runId>.md\n..."                │
                    │          "--- End Memory ---"                 │
                    │                                               │
                    │                     ┌─────────────────────────┘
                    │                     │ contextBuilder() per stage
                    │                     │ → {{memoryContext}} interpolation
                    │                     ▼
                    │              ┌──────────────┐
                    │              │ Every Claude  │  (Plan, Execute — NOT Verify)
                    │              │ invocation    │  receives memory in
                    │              │ system prompt │  its prompt context
                    │              └──────────────┘
                    │
                    │  After run completes (if worthDistilling && !noMemory):
                    │
           ┌────────┴─────────┐
           │ distillMemory()  │
           │                  │
           │ 1. Build prompt  │──→ buildDistillationPrompt(state)
           │ 2. Run Claude    │──→ runClaudeCli({model: distillModel ?? 'sonnet'})
           │ 3. Extract text  │──→ extractTextFromStreamJson(rawOutput)
           │    (strips fences │      (stripMarkdownFence called internally)
           │     internally)   │
           │ 4. Store 3 ways  │──→ see below
           │ 5. Update index  │──→ memoryManager.updateIndex()
           └──────────────────┘
                    │
        ┌───────────┼────────────────────┐
        ▼           ▼                    ▼
  Per-run raw    Per-run clean     Project-level
  ground truth   memory            shared memory
  ┌──────────┐  ┌──────────┐     ┌──────────────┐
  │memory-   │  │memory.md │     │<runId>.md    │
  │distill-  │  │(clean)   │     │(clean)       │
  │ation.log │  └──────────┘     └──────────────┘
  │(NDJSON)  │
  └──────────┘
```

### Reading: Memory Injection into Prompts

Memory is read once at pipeline start and injected into every stage's prompt context.

```
TaskOrchestrator.run()
│
├─ 1. Check !opts.noMemory                      (--no-memory flag disables)
│
├─ 2. memory.buildContextBlock()
│     │
│     ├─ readAll()                               (memoryManager.ts)
│     │   ├─ listFiles()                         → readdirSync, filter *.md, sort
│     │   ├─ sortFilesIndexFirst(files)          → ['index.md', ...rest]
│     │   └─ FOR each file:
│     │       content = readFileSync(file)
│     │       parts.push("### {filename}\n{content}")
│     │   → returns concatenated string
│     │
│     ├─ Wrap with delimiters:
│     │   "--- Project Memory ---\n{content}\n--- End Memory ---"
│     │
│     └─ Optional maxChars budget truncation
│        → returns context block string
│
├─ 3. state.memoryContext = contextBlock          (immutable for entire pipeline)
│
└─ 4. Every stage receives memoryContext via contextBuilder:
      │
      ├─ Plan contextBuilder:
      │   returns { memoryContext: state.memoryContext, ... }
      │   → system prompt has: {{memoryContext}}
      │
      ├─ Execute contextBuilder:
      │   returns { memoryContext: state.memoryContext, ... }
      │   → system prompt has: {{memoryContext}}
      │
      └─ Verify contextBuilder:
          (no memoryContext — Verify focuses on current run only)

      claudeRunner.buildStagePrompt(template, context)
      → delegates to promptBuilder.interpolateTemplate()
      → replaces {{memoryContext}} with actual content
      → assembled prompt sent to Claude CLI
```

**Key design choice**: Memory context is set once at pipeline init and never mutated. All stages
in a single run see the same memory snapshot, preventing mid-run inconsistency.

### Writing: Memory Distillation Pipeline

After a successful run, the distillation pipeline synthesizes reusable insights.

```
TaskOrchestrator.run() — post-completion
│
├─ Check: state.plan?.worthDistilling && !opts.noMemory
│   │
│   │  worthDistilling is a boolean set by the Plan stage.
│   │  The planner decides whether the task is novel enough
│   │  to produce reusable knowledge (trivial tasks → false).
│   │
│   └─ IF false: skip distillation entirely
│
└─ distillMemory(runId, state, logger, memoryManager, opts)
      │                                           (memoryDistiller.ts)
      │
      ├─ 1. buildDistillationPrompt(state)        (memoryDistiller.ts)
      │     │
      │     │  Assembles a summary of what happened:
      │     │  ┌────────────────────────────────────────────┐
      │     │  │ ## Plan Summary                            │
      │     │  │ Build a REST API with 3 endpoints...       │
      │     │  │                                            │
      │     │  │ ## Subtasks                                │
      │     │  │ - [0] Create routes — completed: Added...  │
      │     │  │ - [1] Add tests — completed: Wrote 12...   │
      │     │  │ - [2] Wire middleware — no snapshot         │
      │     │  │                                            │
      │     │  │ ## Verification                            │
      │     │  │ Overall: PASSED                            │
      │     │  │ All integration checks clean.              │
      │     │  └────────────────────────────────────────────┘
      │     │
      │     │  Data sources:
      │     │  - state.plan.summary
      │     │  - state.plan.subtasks[].description
      │     │  - state.subtaskSnapshots.get(index)?.summary
      │     │  - state.verification.overallPass
      │     │  - state.verification.integrationResult?.summary
      │     │
      │     → returns prompt string
      │
      ├─ 2. runClaudeCli({                        (claudeRunner.ts)
      │       prompt,
      │       systemPrompt: DISTILLATION_SYSTEM_PROMPT,
      │       workDir: opts.workDir,
      │       allowedTools: [],                    ← no tools, pure reasoning
      │       model: opts.distillModel ?? 'sonnet' ← configurable via --distill-model
      │     })
      │     │
      │     │  DISTILLATION_SYSTEM_PROMPT instructs structured output:
      │     │  ┌──────────────────────────────────────────────────────┐
      │     │  │ # <Human-readable title>                            │
      │     │  │ > <One-liner for index retrieval, max 150 chars>    │
      │     │  │ ## Summary                                          │
      │     │  │ <100-200 word narrative paragraph>                  │
      │     │  │ ## Key Patterns                                     │
      │     │  │ <Specific reusable patterns with code snippets>     │
      │     │  │ ## Gotchas                                          │
      │     │  │ <Problems and fixes>                                │
      │     │  │ ## Reusable Insights                                │
      │     │  │ <Numbered actionable takeaways>                     │
      │     │  └──────────────────────────────────────────────────────┘
      │     │
      │     → returns RunClaudeResult { rawOutput (NDJSON stream) }
      │
      ├─ 3. NDJSON Extraction Pipeline            (claudeRunner.ts)
      │     │
      │     │  extractTextFromStreamJson(result.rawOutput)
      │     │  │
      │     │  │  Claude CLI outputs NDJSON (newline-delimited JSON):
      │     │  │  ┌─────────────────────────────────────────────────┐
      │     │  │  │ {"type":"system","subtype":"init",...}          │
      │     │  │  │ {"type":"assistant","message":{"content":[...]}}│
      │     │  │  │ {"type":"assistant","message":{"content":[...]}}│
      │     │  │  │ {"type":"rate_limit_event",...}                 │
      │     │  │  │ {"type":"result","result":"# Title\n\n..."}    │
      │     │  │  └─────────────────────────────────────────────────┘
      │     │  │
      │     │  │  Extraction priority:
      │     │  │  1. type='result' with string result field  → use result
      │     │  │  2. type='assistant' text content items     → join all
      │     │  │  3. Fallback                                → raw output
      │     │  │
      │     │  → returns extracted text (may still have markdown fences)
      │     │
      │     │  stripMarkdownFence(text)
      │     │  │  Removes wrapping ```markdown ... ``` or ```md ... ```
      │     │  │  Regex: /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/
      │     │  │
      │     │  → returns clean markdown text
      │
      ├─ 4. Three-Way Storage
      │     │
      │     ├─ a. Raw NDJSON → per-run ground truth
      │     │     logger.appendStageLog(runId, 'memory-distillation', rawOutput)
      │     │     → .dagclaw/runs/<runId>/memory-distillation.log
      │     │     Purpose: audit trail, debugging garbled output
      │     │
      │     ├─ b. Clean text → per-run memory
      │     │     logger.writeRunMemory(runId, cleanText)
      │     │     → .dagclaw/runs/<runId>/memory.md
      │     │     Purpose: per-run snapshot of distilled knowledge
      │     │
      │     └─ c. Clean text → project-level shared memory
      │           filename = runId + '.md'
      │           memoryManager.writeFile(filename, cleanText)
      │           → .dagclaw/memory/<runId>.md
      │           Purpose: cross-run shared knowledge base, browsable by timestamp
      │           Content: structured format from distiller (title, one-liner, summary, details)
      │
      ├─ 5. Regenerate progressive-disclosure index
      │     memoryManager.updateIndex()            (memoryManager.ts)
      │     │
      │     │  ├─ readSummaries()
      │     │  │   ├─ listFiles() excluding 'index.md'
      │     │  │   └─ FOR each file: parseMemoryFile(content)
      │     │  │       → extracts: title (H1), oneliner (> blockquote), summary (## Summary)
      │     │  │       → fallback: first non-heading line if no blockquote
      │     │  │
      │     │  └─ Writes index.md:
      │     │     ┌──────────────────────────────────────────────────────────────────┐
      │     │     │ # DAGClaw Project Memory Index                                  │
      │     │     │                                                                 │
      │     │     │ | Run | Title | Summary |                                       │
      │     │     │ |-----|-------|---------|                                        │
      │     │     │ | [<runId>.md](...) | Human Title | One-liner for retrieval... | │
      │     │     └──────────────────────────────────────────────────────────────────┘
      │     │
      │     → .dagclaw/memory/index.md (overwritten)
      │
      └─ 6. Error handling: non-fatal
            catch (err) → logger.warn() if available
            Pipeline completion is never blocked by distillation failure.
```

### Structured Memory File Format

Each memory file follows a structured format for both human readability and machine retrieval:

```
.dagclaw/memory/{runId}.md

┌──────────────────────────────────────────────────────────────────┐
│ # Human-Readable Title                                          │  ← parseMemoryFile().title
│                                                                  │
│ > One-line summary for index retrieval, max 150 chars.          │  ← parseMemoryFile().oneliner
│                                                                  │
│ ## Summary                                                       │  ← parseMemoryFile().summary
│                                                                  │
│ 100-200 word narrative paragraph covering what was done,         │
│ approach taken, key decisions, and outcome.                      │
│                                                                  │
│ ## Key Patterns                                                  │  ← detailed content
│ ### Pattern A                                                    │
│ Specific reusable pattern with code snippets.                    │
│                                                                  │
│ ## Gotchas                                                       │
│ Problems encountered and fixes.                                  │
│                                                                  │
│ ## Reusable Insights                                             │
│ 1. Actionable takeaway A.                                        │
│ 2. Actionable takeaway B.                                        │
└──────────────────────────────────────────────────────────────────┘
```

**Why this structure**: Designed for two-phase retrieval (v0.2 context management):

```
Phase 1: Index scan                 Phase 2: Summary scan             Phase 3: Full read
─────────────────                   ──────────────────                 ───────────────
index.md table                      readSummaries() →                 readFile(name)
(title + one-liner per run)         MemoryEntry[] with                → full markdown
                                    title, oneliner, summary
Select ~100 most relevant    →      Narrow to ~10-20 relevant    →    Compose detailed
by matching one-liners               by reading 100-200 word           context from
against current task prompt           summaries + run prompts           selected files
```

The `readSummaries()` method (memoryManager.ts) returns `MemoryEntry[]`:
```ts
interface MemoryEntry {
  filename: string;   // e.g. "2026-03-10T02-33-37_838c3e07.md"
  title: string;      // e.g. "Backend REST Endpoints and WebSocket Usage Broadcasts"
  oneliner: string;   // e.g. "Added GET /api/runs endpoints using Express router factory pattern."
  summary: string;    // 100-200 word narrative paragraph
}
```

### CLI Configuration

```
--no-memory          Disable memory reading AND writing (opts.noMemory)
--distill-model X    Model for distillation (opts.distillModel, default: 'sonnet')
                     Decoupled from main pipeline model — distillation is
                     pure reasoning with no tool use, so a smaller model suffices.
```

### Memory File System Layout

```
.dagclaw/
├── memory/                                      ← PROJECT-LEVEL (MemoryManager)
│   ├── index.md                                 ← Auto-generated by updateIndex()
│   │     Three-column table: Run | Title | Summary (one-liner)
│   │     Always read FIRST via sortFilesIndexFirst()
│   │
│   ├── 2026-03-10T02-22-18_641f0bd9.md          ← Run ID as filename
│   │     # Added Model Selection to Memory Distiller
│   │     > Added --distill-model CLI flag threading...
│   │     ## Summary / ## Key Patterns / ## Gotchas / ## Reusable Insights
│   │
│   ├── 2026-03-10T02-33-37_838c3e07.md
│   │     # Backend REST Endpoints and WebSocket Usage Broadcasts
│   │     > Added GET /api/runs endpoints using Express...
│   │
│   └── 2026-03-10T02-58-04_59bc30a9.md
│         # Fixed Memory Distillation Pipeline
│         > Fixed garbled memory caused by raw NDJSON...
│
└── runs/
    └── <runId>/                                 ← PER-RUN (RunLogger)
        ├── memory.md                            ← Clean distilled text
        │     Written by logger.writeRunMemory()
        │     Same content as the project-level <runId>.md file
        │
        ├── memory-distillation.log              ← Raw NDJSON ground truth
        │     Written by logger.appendStageLog('memory-distillation', ...)
        │     Full Claude CLI stream output for auditing
        │
        └── ... (other run artifacts)
```

### Cross-Run Memory Lifecycle

```
Run 1 (novel task)                    Run 2 (benefits from Run 1)
─────────────────                     ─────────────────────────────

Plan stage                            Plan stage
  worthDistilling: true                 (reads memory from Run 1)
  ↓                                     ↓
Execute → Verify                      state.memoryContext includes:
  ↓                                     "### index.md
Post-completion:                         | <runId-1>.md | Title | One-liner... |"
  distillMemory()                       "### <runId-1>.md
  → .dagclaw/memory/<runId-1>.md        # Human Title
  → .dagclaw/memory/index.md            > One-liner for retrieval
    (regenerated)                        ## Summary
                                         100-200 word narrative...
                                         ## Key Patterns / ## Gotchas ..."
                                        ↓
                                      Execute → Verify
                                        (agents see Run 1 knowledge)
                                        ↓
                                      Post-completion:
                                        distillMemory()
                                        → .dagclaw/memory/<runId-2>.md
                                        → .dagclaw/memory/index.md
                                          (regenerated with both entries)

v0.2 (future): Two-phase retrieval replaces full context dump:
  index one-liners → select ~100 → read summaries → narrow ~10-20 → compose context
  readSummaries() already provides the MemoryEntry[] needed for this flow.

Concurrency with git worktrees:
  Memory is project-level, NOT per-worktree. MemoryManager always reads/writes
  the main repo's .dagclaw/memory/. Safe because:
  - filenames are runId-based (no write collisions)
  - buildContextBlock() snapshots once at run start (immutable during run)
  - updateIndex() is a full rewrite from readSummaries() (last-writer-wins is benign)
```

## File System Layout

```
.dagclaw/
├── lock                              ← acquireLock/releaseLock (root only)
│   {pid: 12345, runId: "...", startedAt: "..."}
│
├── memory/                           ← MemoryManager reads/writes
│   ├── index.md                      ← auto-generated progressive disclosure table
│   ├── 2026-03-10T02-22-18_641f0bd9.md ← distilled knowledge (named by run ID)
│   └── 2026-03-10T02-33-37_838c3e07.md ← # slug-title as H1 inside
│
└── runs/
    └── 2026-03-05T18-26-46_7ea06bfd/
        ├── manifest.json             ← RunManifest (updated incrementally)
        ├── plan.json
        ├── plan.log                  ← raw Claude output
        ├── verify.log                ← first verify output
        ├── verify-1.log              ← re-verify output
        ├── verification.json         ← latest result
        ├── verification-0.json       ← first attempt
        ├── verification-1.json       ← retry attempt
        ├── tmp/                      ← run-scoped structured output (persisted)
        │   ├── plan.json
        │   ├── subtask-0-summary.json
        │   ├── subtask-1-summary.json
        │   └── verify.json
        ├── prompts/
        │   ├── plan.md
        │   ├── execute-subtask-0.md
        │   ├── execute-subtask-1.md
        │   ├── execute-subtask-1-retry-1.md
        │   ├── verify.md
        │   └── verify-retry-1.md
        ├── memory.md                 ← clean distilled text (if worthDistilling)
        ├── memory-distillation.log   ← raw NDJSON ground truth
        ├── subtasks/
        │   ├── 0.log
        │   └── 1.log
        └── children/                 ← recursive decomposition child runs
            └── 2026-03-05T18-28-01_48baaa21/
                ├── manifest.json
                ├── plan.json
                ├── tmp/              ← child's own tmp (isolated from parent)
                │   └── ...
                ├── prompts/
                ├── subtasks/
                └── children/         ← grandchild runs (if any)
```
