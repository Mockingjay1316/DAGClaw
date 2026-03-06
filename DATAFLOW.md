# Claw UI — Call Graph & Data Flow

## High-Level Pipeline Flow

```
┌─────────┐     CliOptions       ┌──────────────────┐
│  cli.ts │ ──────────────────→  │ TaskOrchestrator │
│         │     callbacks:       │                  │
│ parseArgs()  {onStatus,        │  run()           │
│ main()  │    onWarning,        │  ├→ Plan stage   │
│ askYesNo()   onApproval}       │  ├→ Execute DAG  │
│         │ ←─── string msgs ──  │  ├→ Verify stage │
└─────────┘                      │  └→ retryLoop()  │
                                 └────────┬─────────┘
                                          │
                    ┌────────────────────┬┴──────────────────┬─────────────────┐
                   ▼                    ▼                    ▼                 ▼
           ┌──────────────┐  ┌──────────────────┐  ┌──────────────┐  ┌────────────────┐
           │ claudeRunner │  │ stageDefinitions │  │  runLogger   │  │ memoryManager  │
           │              │  │                  │  │              │  │                │
           │ runClaudeCli │  │ BUILTIN_STAGES   │  │ initRun()    │  │ readAll()      │
           │ buildStage   │  │ Plan/Execute/    │  │ logPrompt()  │  │ buildContext   │
           │   Prompt()   │  │ Verify configs   │  │ writeVerify()│  │   Block()      │
           └──────┬───────┘  └──────────────────┘  └──────────────┘  └────────────────┘
                  │                                        │
                  ▼                                        ▼
        ┌─────────────────┐                    ┌─────────────────────┐
        │ claude -p (CLI) │                    │ .claw/              │
        │ subprocess      │                    │ ├── runs/<id>/      │
        └─────────────────┘                    │ ├── tmp/            │
                                               │ ├── memory/         │
           ┌───────────────────┐               │ └── lock            │
           │ dependencyResolver│               └─────────────────────┘
           │ DependencyResolver│
           │ detectCircularDeps│
           └───────────────────┘
           ┌──────────────┐
           │ taskManager  │
           │ acquireLock  │
           │ releaseLock  │
           │ checkStale   │
           └──────────────┘
```

## Detailed `run()` Sequence — Data Packets at Each Step

```
TaskOrchestrator.run()
│
├─ 1. checkStaleLock(workDir)
│     → returns {runId: string, pid: number} | null
│
├─ 2. checkClaudeCli()
│     → returns boolean
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
│     │  └───────────────────────────────────────────────┘
│     → returns runId: string
│     → creates .claw/runs/<runId>/manifest.json
│
├─ 5. acquireLock(workDir, runId)
│     → creates .claw/lock {pid, runId, startedAt}
│
├─ 6. memory.buildContextBlock()
│     → reads .claw/memory/*.md
│     → returns "--- Project Memory ---\n## file.md\n<content>\n..."
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
│     └──────────────────────────────────────────────────────┘
│
├─ 8. FOR EACH stage in pipeline:
│     │
│     ├─ getStageDefinition(stageName)
│     │    → returns StageDefinition (from BUILTIN_STAGES)
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
├─ 10. printCostSummary(runId)
└─ 11. releaseLock(workDir)
```

## `runOne()` — Single Execution Primitive

Every Claude invocation flows through this method.

```
runOne(runId, stage, state, subtask?)
│
├─ 1. Compute output file path
│     subtask? → ".claw/tmp/subtask-{N}-summary.json"
│     stage    → ".claw/tmp/{stage}.json"
│
├─ 2. stage.contextBuilder(state, outputFile, subtask?)
│     │
│     │  Plan returns:
│     │  ┌──────────────────────────────────────┐
│     │  │ workDir: "/path/to/project"          │
│     │  │ prompt: "Build a CLI tool..."        │
│     │  │ memoryContext: "--- Memory ---\n..." │
│     │  │ outputFile: ".claw/tmp/plan.json"    │
│     │  └──────────────────────────────────────┘
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
│     │  │ outputFile: ".claw/tmp/subtask-0-summary.json"         │
│     │  └────────────────────────────────────────────────────────┘
│     │
│     │  Verify returns:
│     │  ┌──────────────────────────────────────────────┐
│     │  │ workDir: "/path/to/project"                  │
│     │  │ planSummary: "Build 3-file project..."       │
│     │  │ subtaskSummaries: "[Subtask 0] Created..."   │
│     │  │ skippedIndices: "none" | "1, 2"              │
│     │  │ outputFile: ".claw/tmp/verify.json"          │
│     │  └──────────────────────────────────────────────┘
│     │
│     → returns Record<string, string>  (template variables)
│
├─ 3. buildStagePrompt(template, context)
│     │  interpolates {{placeholders}} in promptTemplate
│     → returns assembled prompt string
│
├─ 4. logger.logStagePrompt(runId, stageName, prompt, systemPrompt, subtaskIndex?)
│     → writes .claw/runs/<id>/prompts/{stage}.md
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
├─ DependencyResolver(subtasks)
│    internally builds:
│    ┌─ state per index ───────────────────────┐
│    │ 0: {deps: [],    status: "pending"}     │
│    │ 1: {deps: [],    status: "pending"}     │
│    │ 2: {deps: [0,1], status: "pending"}     │
│    └─────────────────────────────────────────┘
│
├─ WHILE !resolver.allComplete():
│    │
│    ├─ resolver.getReady()
│    │   → returns indices whose deps are all "complete"
│    │   → e.g. first iteration: [0, 1]  (no deps)
│    │
│    ├─ batch = ready.slice(0, maxConcurrency)
│    │
│    ├─ Promise.allSettled(batch.map(runOne))
│    │   → runs subtasks in parallel up to maxConcurrency
│    │
│    └─ FOR each result:
│         fulfilled → resolver.markComplete(idx)
│                     status(displayMessage)
│         rejected  → cascaded = resolver.markSkipped(idx)
│                     → returns downstream indices that were cascade-skipped
│                     state.skippedIndices.add(idx)
│                     FOR each cascadedIdx: state.skippedIndices.add(cascadedIdx)
│                     status("[Execute] [2] Skipped (cascade from 0)")
│
│  Iteration example (3 subtasks, diamond dep):
│    Iter 1: ready=[0,1] → run both → both complete
│    Iter 2: ready=[2]   → run 2   → complete
│    allComplete() → true → exit
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

## Structured Output Schemas (Zod)

Agents write JSON to `.claw/tmp/` files. The orchestrator's `runOne()` validates via each stage's declared `outputSchema` (Zod), then passes parsed data to `resultHandler`:

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
      "needsRecursiveDecomposition": false
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
  "oneliner": "one-line description"
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

## File System Layout

```
.claw/
├── lock                              ← acquireLock/releaseLock
│   {pid: 12345, runId: "...", startedAt: "..."}
│
├── memory/                           ← MemoryManager reads
│   ├── conventions.md
│   └── patterns.md
│
├── tmp/                              ← cleaned per run, agents write here
│   ├── plan.json
│   ├── subtask-0-summary.json
│   ├── subtask-1-summary.json
│   └── verify.json
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
        ├── prompts/
        │   ├── plan.md
        │   ├── execute-subtask-0.md
        │   ├── execute-subtask-1.md
        │   ├── execute-subtask-1-retry-1.md
        │   ├── verify.md
        │   └── verify-retry-1.md
        └── subtasks/
            ├── 0.log
            └── 1.log
```
