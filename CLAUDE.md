# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Claw UI is a multi-stage recursive orchestration engine for Claude Code. It decomposes tasks into subtasks via a Plan → Execute → Verify pipeline, running subtasks in parallel via DAG scheduling. Supports recursive decomposition, custom stages via `claw.config.json`/`.ts`, per-subtask stage routing, and pipeline-aware planning.

## Commands

```bash
# Run tests (all)
node --import tsx --test src/__tests__/*.test.ts

# Run a single test file
node --import tsx --test src/__tests__/cli.test.ts

# Type check
npx tsc --noEmit

# Run CLI
node --import tsx bin/claw.js "your task"

# Run history
node --import tsx bin/claw.js runs
node --import tsx bin/claw.js runs --last
```

Note: Node.js is installed via nvm. If `node` is not on PATH, run `source ~/.nvm/nvm.sh` first.

## Architecture

**Pipeline**: Plan (mandatory) → DAG (heterogeneous execution) → Post-stages (mandatory, e.g., Verify). Each stage is a `StageDefinition` with `contextBuilder`, `resultHandler`, and `formatStatus`. The orchestrator is stage-agnostic — all stage-specific logic lives in `src/stageDefinitions.ts`.

**Single execution primitive**: `TaskOrchestrator.runOne()` handles both standalone stages (Plan, Verify) and individual subtasks within parallel stages. System prompts and prompt templates are both interpolated with `{{key}}` placeholders from `contextBuilder`. DAG scheduling via `DependencyResolver`.

**Per-subtask stage routing**: Subtasks in the DAG can specify a `stage` field to route to different stage definitions (e.g., Execute, Lint, Verify). The planner receives the DAG palette (available stages) and post-stage info via system prompt interpolation. `--dag-stages` CLI flag controls the palette.

**Custom stages**: Users define stages in `claw.config.json` or `claw.config.ts`. Loaded by `src/configLoader.ts`, merged with built-in stages, and passed as a registry to the orchestrator.

**Recursive decomposition**: When a subtask has `needsRecursiveDecomposition: true`, a child `TaskOrchestrator` is spawned with its own pipeline. Only Execute-stage subtasks can recurse. Depth is tracked and limited by `maxDepth`. `TaskRegistry` tracks parent/child relationships.

**Structured output via files**: Agents write JSON to run-scoped tmp dirs (`.claw/runs/<runId>/tmp/`). Each orchestrator instance gets its own tmp directory, preventing collisions during recursive runs. Orchestrator reads and validates via Zod schemas in `claudeRunner.ts`.

**Key files**:
- `src/types.ts` — All interfaces and Zod schemas (`PipelineState`, `StageDefinition`, `Plan`, etc.)
- `src/claudeRunner.ts` — Claude CLI execution, prompt building, output parsing, usage tracking
- `src/stageDefinitions.ts` — Built-in Plan/Execute/Verify stage configs, `formatStageDescriptions()`
- `src/configLoader.ts` — Custom stage loading from `claw.config.json`/`.ts`, stage merging
- `src/taskOrchestrator.ts` — Pipeline driver, DAG scheduling, per-subtask stage routing, recursive decomposition
- `src/dagDisplay.ts` — Live DAG status display (TTY ANSI in-place updates, non-TTY fallback), stage ticker
- `src/dependencyResolver.ts` — Topological sort, cycle detection, skip cascading
- `src/runLogger.ts` — Persistent logging to `.claw/runs/`
- `src/memoryManager.ts` — Memory distillation and injection from `.claw/memory/`
- `src/taskManager.ts` — Lockfile management, task node creation, `TaskRegistry` for parent/child tracking
- `src/promptBuilder.ts` — Template interpolation, snapshot formatting
- `src/cli.ts` — CLI entry point, arg parsing, terminal output

## Conventions

- **TDD**: Write tests first, then implementation
- **Test runner**: `node:test` (built-in, zero deps)
- **No build step**: TypeScript runs directly via tsx
- **Small functions**: Keep each function small and focused
- **PLAN.md sync**: Update PLAN.md when code deviates from it

## Architecture & Execution Plan

See `PLAN.md` for full system architecture and phased implementation plan.
