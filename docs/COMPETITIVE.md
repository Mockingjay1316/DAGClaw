# DAGClaw — Competitive Analysis

Comparing DAGClaw against three open-source orchestration projects: DeerFlow (ByteDance), OpenClaw/ClawFlow, and Lobster.

---

## Project Summaries

**DAGClaw** — TypeScript/Node.js. Explicit DAG orchestration via Plan→Execute→Verify pipeline. Stages as data (StageDefinition configs). Single execution primitive (`runOne()`). Greedy scheduler. Cache-optimized prompts. 2 core deps (zod, tsx).

**DeerFlow** (ByteDance) — Python/LangGraph. Multi-specialized agents (Researcher, Coder, Analyst, Reporter). StateGraph with implicit routing. Lead agent middleware pipeline. Markdown-based skills (SKILL.md). 6 tool sources including MCP. Sandbox abstraction (Local/Docker/K8s).

**OpenClaw/ClawFlow** — TypeScript/Node.js. "Consulting firm" model — all agents are identical, each decides to execute directly or decompose into a DAG and delegate. Mailbox-based inter-agent messaging. Workspace markdown files for state. 5,400+ skills via ClawHub registry. Natural-language workflow creation.

**Lobster** (OpenClaw's) — TypeScript. Typed workflow shell — sequential JSON pipelines with approval gates. Deterministic execution. Resumability via checkpoint tokens. Sub-workflow composition with looping. "Typed pipelines beat prompt engineering for coordination."

---

## Architectural Comparison

| Aspect | DAGClaw | DeerFlow | OpenClaw/ClawFlow | Lobster |
|--------|---------|----------|-------------------|---------|
| **Orchestration** | Explicit DAG, topological sort | LangGraph StateGraph | Dynamic runtime decomposition | Sequential JSON pipelines |
| **Execution** | Stages as data configs | Specialized agent types | Identical agents decide | Shell commands + JSON pipes |
| **Plan model** | Plan = execution contract | Emergent path | Agent-decided decomposition | Static YAML workflow |
| **Parallelism** | Greedy scheduler (Promise.race) | Thread pool | Agent-level parallel dispatch | None (sequential) |
| **Accountability** | plan.json + subtask logs | Reconstruct from logs | Mailbox audit trail | Pipeline as data structure |
| **Human-in-loop** | Plan approval + retry choices | Plan review + edit | Approval at any point | Approval gates per step |
| **Resumability** | Re-run from plan | N/A | Task.md state recovery | Resume tokens from gates |
| **State** | `.dagclaw/runs/` + `.dagclaw/memory/` | memory.json + archival | Workspace markdown + mailbox | JSON step outputs in memory |
| **Skills/Config** | Custom stages (config.json/.ts) | SKILL.md files | ClawHub registry (5,400+) | YAML workflow files |
| **Deps** | 2 (zod, tsx) | LangGraph, LangChain, FastAPI... | OpenClaw ecosystem | Minimal (shell) |
| **Language** | TypeScript | Python | TypeScript | TypeScript |

---

## Where DAGClaw Is Stronger

### 1. Plan as execution contract

DAGClaw's plan.json is a complete, inspectable, approvable DAG with explicit dependencies. You know exactly what will execute in what order before anything runs. DeerFlow's path is emergent. ClawFlow's decomposition is agent-decided at runtime. Lobster's is static but sequential-only. DAGClaw's plan is the unique accountability guarantee — it's both the spec and the audit trail.

### 2. Stage-agnostic orchestrator

`TaskOrchestrator` has zero stage-specific logic. Adding a new stage type requires zero orchestrator changes. DeerFlow hardcodes agent types. ClawFlow's agents are identical but the orchestration logic is coupled to the messaging protocol. Lobster has no concept of stages.

### 3. DAG-native parallelism

DAGClaw's greedy scheduler with dependency resolution handles diamond DAGs, independent branches, cascade-skip — all natively. ClawFlow delegates parallelism to agents. Lobster is purely sequential. DeerFlow uses LangGraph's implicit threading.

### 4. Cache-optimized prompt ordering

~80% cache rate on typical DAGs by placing stable content (system, memory, plan) before volatile content (snapshots, task prompt). None of the others optimize for this.

### 5. Recursive decomposition with depth control

Subtasks can spawn child orchestrators with own Plan→Execute→Verify pipelines, tracked in the run log tree. ClawFlow has recursive decomposition too, but without the structured pipeline or depth limits.

### 6. Custom stages as a general-purpose mechanism

The `StageDefinition` interface — with `contextBuilder`, `resultHandler`, `outputSchema`, `allowedTools`, `parallel`, `approvalRequired` — is expressive enough to implement any workflow step type. This is more powerful than Lobster's "shell command + JSON pipe" model and more controlled than DeerFlow's per-agent-type logic.

---

## What Others Do Better (And What Matters)

### From DeerFlow

- **Sandbox abstraction** — Already on DAGClaw's roadmap. Reinforced as priority.
- **Memory auto-distillation** — DAGClaw's `worthDistilling` flag is dead code. Need to close the loop.
- **Context budget enforcement** — DAGClaw has the parameter but no enforcement path.

### From OpenClaw/ClawFlow

- **Durable mailbox audit trail** — DAGClaw already has this via `.dagclaw/runs/` logs, arguably better structured.
- **Skill registry/marketplace** — ClawHub has 5,400+ skills. DAGClaw could benefit from shareable stage presets, but a full marketplace is out of scope. The `dagclaw.presets/` concept (importable config fragments) covers the practical need.
- **Dynamic runtime decomposition** — ClawFlow agents decide at runtime whether to execute or decompose. DAGClaw's planner decides upfront. Both are valid; DAGClaw's approach is more predictable and auditable. The planner marking subtasks for recursive decomposition achieves the same effect with better visibility.

### From Lobster

- **Resumability via checkpoint tokens** — Lobster can pause at approval gates and resume from a compact token. DAGClaw's plan replay (proposed) achieves similar but coarser-grained resume. Per-subtask resume by recording completed subtask indices in the manifest and skipping them on re-run is on the roadmap.
- **Typed JSON data flow between steps** — Lobster passes structured JSON between steps via `stdin: $stepId.stdout`. DAGClaw passes context between subtasks via ContextSnapshots injected into prompts. Lobster's approach is more deterministic for data pipelines; DAGClaw's is more flexible for creative/coding tasks where the "output" is code changes, not data.
- **"Typed pipelines beat prompt engineering for coordination"** — Good principle. DAGClaw already follows it: the DAG structure, dependency edges, and structured output schemas (Zod) are all typed contracts. The prompts handle task execution, not coordination.

---

## The Skills Question

ClawFlow's skill ecosystem (5,400+ skills on ClawHub) is impressive but orthogonal to DAGClaw's architecture. ClawFlow skills are prompt-based behavior definitions loaded into agent context. In DAGClaw:

- **Domain knowledge** → `.dagclaw/memory/*.md` (already exists)
- **Execution environment** → `StageDefinition` in `dagclaw.config.json/.ts` (already exists)
- **Reusable workflows** → Plan replay from saved plan.json (proposed)
- **Shareable presets** → Importable config fragments (proposed as `dagclaw.presets/`)

**Recommendation: Don't add a separate skills system.** The existing mechanisms cover all use cases. The only gap is a packaging/distribution mechanism for shareable stage presets, which is much simpler than a full skill ecosystem.

---

## What NOT to Add

| Feature | Why Not |
|---------|---------|
| Multi-specialized agent types | Per-subtask stage routing already handles heterogeneous execution |
| Full middleware pipeline | Two lifecycle hooks suffice |
| Separate skills/marketplace | Memory + custom stages + plan replay cover all use cases |
| Framework-level MCP management | Claude Code handles MCP natively |
| LangGraph/StateGraph integration | Would replace explicit DAG with opaque graph runtime |
| Dynamic runtime decomposition | Planner + recursive decomposition achieves the same with better visibility |

---

## Core Differentiator

DAGClaw's value proposition: **A well-managed pipeline/workflow with explicit plan accountability and DAG-based parallel execution.** The plan is both the spec and the audit trail. The stage-agnostic orchestrator makes it domain-agnostic. The explicit DAG provides accountability and auditability that emergent-execution systems cannot provide.
