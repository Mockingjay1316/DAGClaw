# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

DAGClaw is a general-purpose multi-stage recursive orchestration engine. It decomposes tasks into subtasks via configurable pipelines (default: Plan → Execute → Verify), running subtasks in parallel via DAG scheduling with greedy dependency resolution. The engine is domain-agnostic — custom stages make it suitable for software engineering, research, content generation, data processing, or any multi-step task with dependencies.

Key properties:
- **Plan as execution contract**: The plan is inspectable, approvable, and serves as both spec and audit trail
- **Stage-agnostic orchestrator**: Zero stage-specific logic — all behavior defined via `StageDefinition` configs
- **DAG-native parallelism**: Greedy scheduler with topological sort, diamond DAGs, cascade-skip
- **Agentic loop compatible**: Works as a human-facing CLI tool AND as a building block for autonomous agent systems — the outer loop (human or agent) provides the "what", DAGClaw provides the "how" with full transparency

Supports recursive decomposition, custom stages via `dagclaw.config.json`/`.ts`, per-subtask stage routing, and pipeline-aware planning.

## Commands

```bash
# Run tests (core + CLI)
node --import tsx --test 'core/__tests__/*.test.ts' 'cli/__tests__/*.test.ts'

# Run backend tests
node --import tsx --test 'backend/__tests__/*.test.ts'

# Run all tests
node --import tsx --test 'core/__tests__/*.test.ts' 'cli/__tests__/*.test.ts' 'backend/__tests__/*.test.ts'

# Run a single test file
node --import tsx --test core/__tests__/taskOrchestrator.test.ts

# Type check
npx tsc --noEmit

# Run CLI (dagclaw is the primary name, claw is an alias)
node --import tsx bin/dagclaw.js "your task"
node --import tsx bin/claw.js "your task"

# Run history
node --import tsx bin/dagclaw.js runs
node --import tsx bin/dagclaw.js runs --last

# Start backend server
node --import tsx backend/src/index.ts

# Start full stack (backend + frontend)
bash scripts/start_server.sh

# Stop full stack
bash scripts/stop_server.sh

# Start frontend dev server (manually)
cd frontend && npm install && npm run dev
```

Note: Node.js is installed via nvm. If `node` is not on PATH, run `source ~/.nvm/nvm.sh` first.

## Architecture

**Project structure**: `core/` (shared orchestration engine), `cli/` (CLI entry point + terminal display), `backend/` (Express + WebSocket server), `frontend/` (React + Vite + xterm.js UI), `scripts/` (server start/stop), `docs/` (architecture docs, competitive analysis).

**Pipeline**: Plan (mandatory) → DAG (heterogeneous execution) → Post-stages (mandatory, e.g., Verify). Each stage is a `StageDefinition` with `contextBuilder`, `resultHandler`, and `formatStatus`. The orchestrator is stage-agnostic — all stage-specific logic lives in `core/stageDefinitions.ts`.

**Single execution primitive**: `TaskOrchestrator.runOne()` handles both standalone stages (Plan, Verify) and individual subtasks within parallel stages. System prompts and prompt templates are both interpolated with `{{key}}` placeholders from `contextBuilder`. DAG scheduling via `DependencyResolver`.

**Per-subtask stage routing**: Subtasks in the DAG can specify a `stage` field to route to different stage definitions (e.g., Execute, Lint, Verify). The planner receives the DAG palette (available stages) and post-stage info via system prompt interpolation. `--dag-stages` CLI flag controls the palette.

**Custom stages**: Users define stages in `dagclaw.config.json` or `dagclaw.config.ts`. Loaded by `core/configLoader.ts`, merged with built-in stages, and passed as a registry to the orchestrator. This makes the engine domain-agnostic — a "Research" stage, a "WriteReport" stage, or a "GenerateSlides" stage are all just `StageDefinition` configs.

**Recursive decomposition**: When a subtask has `needsRecursiveDecomposition: true`, a child `TaskOrchestrator` is spawned with its own pipeline. Only Execute-stage subtasks can recurse. Depth is tracked and limited by `maxDepth`. `TaskRegistry` tracks parent/child relationships.

**Structured output via files**: Agents write JSON to run-scoped tmp dirs (`.dagclaw/runs/<runId>/tmp/`). Each orchestrator instance gets its own tmp directory, preventing collisions during recursive runs. Orchestrator reads and validates via Zod schemas in `claudeRunner.ts`.

**General-purpose pipelines**: The pipeline is user-defined via `--pipeline`. Examples:
- Software engineering: `Plan,Execute,Verify`
- Research: `Plan,Research,Synthesize,Verify`
- Content generation: `Plan,Draft,Review,Polish`
- Data processing: `Plan,Extract,Transform,Validate`

**Key files**:
- `core/types.ts` — All interfaces and Zod schemas (`PipelineState`, `StageDefinition`, `Plan`, `DAGEvent`, etc.)
- `core/claudeRunner.ts` — Claude CLI execution, prompt building, output parsing, usage tracking
- `core/stageDefinitions.ts` — Built-in Plan/Execute/Verify stage configs, `formatStageDescriptions()`
- `core/configLoader.ts` — Custom stage loading from `dagclaw.config.json`/`.ts`, stage merging
- `core/taskOrchestrator.ts` — Pipeline driver, DAG scheduling, per-subtask stage routing, recursive decomposition
- `core/dependencyResolver.ts` — Topological sort, cycle detection, skip cascading
- `core/runLogger.ts` — Persistent logging to `.dagclaw/runs/`
- `core/memoryManager.ts` — Memory storage, retrieval, index generation from `.dagclaw/memory/`
- `core/memoryDistiller.ts` — Post-run knowledge extraction: Claude summarizes run → structured memory file
- `core/taskManager.ts` — Lockfile management, task node creation, `TaskRegistry` for parent/child tracking
- `core/promptBuilder.ts` — Template interpolation, snapshot formatting
- `cli/cli.ts` — CLI entry point, arg parsing, terminal output
- `cli/dagDisplay.ts` — Live DAG status display (TTY ANSI in-place updates, non-TTY fallback), stage ticker
- `backend/src/routes/runs.ts` — REST endpoints for run history and manifests
- `frontend/src/stores/orchestratorStore.ts` — Zustand store, WS message handler, selectors
- `frontend/src/hooks/useWebSocket.ts` — Singleton WS connection, reconnection, subscription management

## Conventions

- **TDD**: Write tests first, then implementation
- **Test runner**: `node:test` (built-in, zero deps)
- **No build step**: TypeScript runs directly via tsx
- **Small functions**: Keep each function small and focused
- **PLAN.md sync**: Update docs/PLAN.md when code deviates from it

## Documentation

- `docs/PLAN.md` — Full system architecture and phased implementation plan
- `docs/PHILOSOPHY.md` — Core design beliefs and guiding principles
- `docs/DATAFLOW.md` — Call graph and data flow documentation
- `docs/COMPETITIVE.md` — Competitive analysis (DeerFlow, OpenClaw/ClawFlow, Lobster)
