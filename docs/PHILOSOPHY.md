# DAGClaw — Design Philosophy

These beliefs guide all development decisions. When in doubt, refer here.

## Self-building

DAGClaw builds itself. Phase 0 was hand-written (~10 files, ~2,000 lines). Phases 1–5 were built by DAGClaw using itself as the orchestrator — each phase was a `dagclaw` task that planned, executed, and verified its own implementation. Future features (v0.1.1+) will continue this pattern.

DAGClaw is both the product and the primary development tool. This creates a virtuous cycle: every improvement to the orchestrator makes the next self-improvement run more effective. Dogfooding is not optional — it's the development methodology.

## Claude CLI is the agent

The Claude CLI (`claude -p`) is already agentic — it reads files, writes code, runs tests, iterates on failures. It will become more capable over time. There is no need to wrap it in another "agent" layer with tool definitions, memory, or identity (the OpenClaw/ClawFlow approach).

DAGClaw's value is **orchestration**: decomposition, scheduling, context management, verification. Not agency. Each subtask gets a fresh Claude instance with precisely scoped context. No persistent agent identity, no agent state, no agent-to-agent protocols.

## Context management over agent communication

"Agents talking to each other" is equivalent to launching new Claude instances with updated context. There are no conversations between agents — only data flow. A subtask receiving its predecessor's context snapshot is functionally identical to an "agent message" but without the illusion of persistent identity.

Memory and context management are the heart of the framework:
- What context does each subtask receive? (snapshots, memory, file state)
- How much context fits in the budget? (drop strategies, relevance scoring)
- What's worth remembering for future runs? (memory distillation)
- How do you find the right memories? (structured retrieval: index → summary → detail)

Memory files are structured for retrieval, not just storage. Each has a human-readable title, a one-line summary for index scanning, a 100-200 word narrative for relevance assessment, and detailed patterns/gotchas for actual use. This mirrors how recommendation systems work: coarse filter → fine filter → full content.

These are the hard problems. Inter-agent chat protocols are a distraction.

## Plans as execution contracts

The plan is the primary control surface. It's inspectable, approvable, and serves as both specification and audit trail. The DAG structure constrains execution order — subtask 2 cannot run before its dependencies complete.

This is fundamentally different from emergent-execution systems where agents decide what to do next at runtime. In DAGClaw, the plan is decided upfront, approved by a human (or outer agent), and then executed deterministically. The plan is the contract.

Plan replay (`--plan <runId>`) and dry run (`--dry-run`) are natural consequences of this design — they're impossible in emergent-execution systems because there's no plan to replay.

## Stage-agnostic orchestration

The orchestrator has zero stage-specific logic. All behavior is defined via `StageDefinition` configs: `contextBuilder`, `resultHandler`, `formatStatus`, `parallel`, `approvalRequired`. The orchestrator loop reads these flags and acts accordingly.

Adding a new stage — Research, Draft, Review, Validate, Lint, anything — requires no changes to the orchestrator. Just a config object. This makes the engine domain-agnostic: software engineering, research workflows, content pipelines, data processing all use the same orchestrator with different stage configs.

## Transparency and accountability

Every run is fully logged:
- Exact prompts sent to Claude (`.dagclaw/runs/<id>/prompts/`)
- Raw Claude output (`.dagclaw/runs/<id>/*.log`)
- Structured results (plan, verification, subtask summaries)
- Costs incurred (per-stage token counts and cost estimates)
- Timing data (per-subtask and total duration)

The prompt inspector, run history, and context flow visualization make the system's decisions legible. No black-box agent behavior. When something goes wrong, you can trace exactly what happened: what context was provided, what Claude produced, and why.

## UI as the leverage point

The backend engine is mature — orchestration, scheduling, logging, memory all work. The frontend is where the most user value has been created:
- **Kanban board** with drag-and-drop-ready columns (TODO, Queued, Need Review, Running, Failed, Done) gives immediate visual status across all tasks
- **Activity timeline** showing all task events as they happen
- **Cost/token display** per task, making spend transparent at every level
- **Run history browser** for learning from past runs and replaying plans
- **HTTP REST + WS split**: REST handles commands and queries (including historical plan/verification load from run logs), WebSocket is used exclusively for real-time push — clean separation of concerns
- **Auto-subscription lifecycle management**: the frontend subscribes to exactly the tasks it needs and cleans up automatically

Remaining future work:
- Plan editing before execution (adjust the DAG before committing)
- Context flow visualization (what does each subtask see?)
- Interactive DAG manipulation (reorder, add, remove subtasks visually)

The CLI will always exist for power users and automation. But for understanding what DAGClaw is doing and why, the UI is essential.

## Reasoning and action are different workloads

Today, a single Claude CLI instance both reasons about code (reading, planning, writing) and performs actions (running tests, builds, deploys). This means an Opus-class model sits idle watching `npm test` for 30 seconds. These are fundamentally different workloads:

- **Reasoning** needs large context windows, expensive models, and deep understanding. It's CPU-light but token-heavy.
- **Action** needs compute, filesystem access, and specific toolchains. It needs minimal intelligence — just execute a command and report the result.

DAGClaw's stage-agnostic orchestrator already treats each subtask as an independent unit with a `StageRunnerConfig`. Adding a `runner` discriminator (`'claude' | 'shell' | 'remote'`) is a natural extension: the orchestrator doesn't care how a stage runs, only that it produces a result. This decoupling matches how companies actually work — developers reason on laptops, builds run on CI servers, heavy compute runs on GPU boxes. DAGClaw should coordinate all of this from one DAG, with one plan, one audit trail.
