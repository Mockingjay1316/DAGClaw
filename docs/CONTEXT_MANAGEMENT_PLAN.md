# Context Management Plan

> Comprehensive overhaul of DAGClaw's memory and context system — from run-centric to knowledge-centric, freshness-aware, selectively retrieved.

## Problem Statement

DAGClaw's current memory system is **run-centric**: every memory file is a distilled run log (`<runId>.md`), and the 10 most recent files are dumped into every stage prompt regardless of relevance. This causes three problems:

1. **Token waste** — irrelevant run memories consume context budget and add noise
2. **No project knowledge** — durable facts ("uses JWT auth", "tests use node:test") are scattered across 50 run files instead of consolidated
3. **Staleness** — when the user edits code between runs, past memories can reference deleted files, refactored patterns, or reversed decisions — with no way to detect this

The user works **alongside** DAGClaw. The codebase evolves independently between runs. Memory must be knowledge-centric (not run-centric), freshness-aware, and selectively retrieved.

---

## Architecture: Four Memory Categories

| Category | Storage | Lifecycle | Staleness |
|----------|---------|-----------|-----------|
| **Project Knowledge** | `.dagclaw/memory/knowledge/*.md` | Created by distillation, updated by merging | Low — validated against codebase |
| **Run History** | `.dagclaw/memory/<runId>.md` (unchanged) | Immutable after creation | High — references past codebase state |
| **Working Context** | Computed at run start, stored in `.dagclaw/memory/.working-context.json` | Auto-computed every run; injection into prompts is a separate decision | Always fresh by definition |
| **User Context** | `.dagclaw/context/*.md` (future) | User-managed | Never stale |

**Key change**: Distillation now produces **two outputs** — the run memory (what happened) and knowledge extraction (what the project should remember). Knowledge extraction is **hybrid**: rule-based for deterministic facts (git diff, directory structure changes, file renames, dependency changes) + LLM-based for unstructured accumulated knowledge (patterns, conventions, architectural decisions). Knowledge files are topic-based (`auth-system.md`, `testing-conventions.md`) and evolve across runs.

---

## ContextEngine Interface

A pluggable interface that replaces direct `MemoryManager` usage in the orchestrator.

### New file: `core/contextEngine.ts`

```typescript
interface ContextEngine {
  // Build memory context string for pipeline injection
  buildContext(query: string, budget: ContextBudget): Promise<string>;

  // Store memory entry after distillation
  store(entry: MemoryWrite): Promise<void>;

  // Update staleness metadata based on codebase changes
  refreshStaleness(changes: CodebaseChanges): Promise<void>;

  // List all entries with metadata (for UI/CLI display)
  listEntries(): Promise<ContextEntry[]>;
}
```

**Integration point** — single change in `taskOrchestrator.ts`:

```typescript
// Before (line 221):
memoryContext: this.memory.buildContextBlock()
// After:
memoryContext: await this.contextEngine.buildContext(this.opts.prompt, { maxChars: budget })
```

The `PipelineState.memoryContext` stays a string. All `contextBuilder` functions and template interpolation work unchanged. The orchestrator remains stage-agnostic.

### Default implementation: `FileContextEngine`

Filesystem-based, wraps existing `MemoryManager` for backward compatibility. Implements the three-phase retrieval pipeline below.

---

## Three-Phase Selective Retrieval

Replaces the current "dump 10 recent files" approach. Runs inside `FileContextEngine.buildContext()`.

### Phase 1 — Index Scan (coarse filter)

- Load all `MemoryEntry` objects via existing `readSummaries()`
- Score by: keyword overlap (title + oneliner vs task prompt), recency bonus, category bonus (knowledge > run), staleness penalty
- Take top 30-50 candidates
- No file I/O beyond metadata — fast

### Phase 2 — Summary Scan (relevance scoring)

- Read 100-200 word summaries of Phase 1 survivors (already in `readSummaries()` output)
- Score by: bigram matching, file path overlap with task, technical domain overlap
- Apply aggressive staleness discount: `score *= max(0, 1 - staleness * 1.5)` — entries with staleness > 0.67 are effectively excluded
- Take top 5-15 entries (budget-dependent)

### Phase 3 — Context Assembly (compose final block)

- Read full content of selected entries
- Order for cache optimization: knowledge first (stable) → working context → run memories (by relevance)
- Budget allocation: knowledge 40%, working context 10%, run memories 50% (soft targets, surplus flows)
- Truncate at section boundaries (drop `## Reusable Insights` before `## Summary`)
- Wrap with `--- Project Memory ---` / `--- End Memory ---` delimiters

All scoring is keyword/heuristic-based — no embeddings, no LLM calls during retrieval. A vector store `ContextEngine` implementation would replace Phase 1-2 with embedding similarity search in the future.

---

## Staleness Detection

### New file: `core/stalenessTracker.ts`

At pipeline start, before retrieval:

1. Read `commitAfter` from most recent completed run manifest
2. `git diff --name-only <commitAfter>..HEAD` → list of changed files
3. Cross-reference each memory entry's `referencedFiles` against changed files
4. Compute staleness score (0-1): 0 = fresh, 1 = references deleted files
5. Store in `.dagclaw/memory/.staleness.json`

### Staleness thresholds

- `staleness < 0.3`: Include normally (minor file changes, knowledge likely still valid)
- `staleness 0.3-0.7`: Include **only if relevance score is in top 3** for the current task. Otherwise exclude.
- `staleness > 0.7`: **Exclude by default**. Major file changes or deletions — the memory is more likely to mislead than help.
- `staleness = 1.0`: Referenced files deleted. Always excluded.

The retrieval engine applies a steep discount: `score *= max(0, 1 - staleness * 1.5)` — at staleness 0.67+, the score goes to zero. This ensures stale memories only survive if they are overwhelmingly relevant.

Stale memories are never auto-deleted from disk (preserved for audit). The `dagclaw memory refresh` command lets users manually re-validate or clean up.

**Prerequisite**: Populate `ContextSnapshot.filesModified` (currently hardcoded to `[]` in `stageDefinitions.ts:347`) and `RunManifest.gitInfo.filesModified`. This enables cross-referencing.

---

## Distillation Evolution

### Modified file: `core/memoryDistiller.ts`

Three-step distillation after each run:

**Step 1**: Run memory distillation (unchanged) → `<runId>.md`

**Step 2**: Rule-based knowledge extraction (new, free)

- Parse git diff from the run → extract: files created/modified/deleted, directory structure changes, dependency changes (package.json), config changes
- Store as structured facts in `knowledge/codebase-state.md` (auto-updated, no LLM needed)
- This gives future runs a deterministic snapshot of what the project looks like

**Step 3**: LLM-based knowledge extraction (new, second Claude call)

- Reads: the just-created run memory + existing knowledge files from `.dagclaw/memory/knowledge/`
- Extracts unstructured, accumulated knowledge: patterns, conventions, gotchas, architectural decisions
- Produces JSON actions:
  - `create` — new topic file in `knowledge/`
  - `update` — merge new info into existing knowledge file (LLM produces merged content)
  - `skip` — run-specific info, not worth persisting as knowledge

Knowledge files evolve over time. `auth-system.md` starts with basic JWT info after run 3, gets updated with rate limiting after run 7, gets corrected about token expiry after run 12.

Contradiction resolution: the extraction prompt instructs Claude to update knowledge when new run results contradict existing knowledge, noting changes in a `## Change History` section.

**Working context**: Git diff is always auto-computed at run start and stored in `.dagclaw/memory/.working-context.json`. Whether this gets injected into prompts is a separate decision made by the retrieval pipeline — it may be useful for staleness tracking even when not directly injected.

---

## Context Budget Management

### Budget computation

```
memoryBudget = maxContextChars - systemPromptSize - estimatedStageContent - safetyMargin
```

- **Plan stage**: 60% of remaining space (needs most historical context)
- **Execute stage**: 40% of remaining space (constrained by predecessor context)
- **Verify stage**: 0% (focuses on current run state — existing behavior)
- **Custom stages**: Configurable via `StageDefinition.contextBudgetChars`

### Priority-based pruning (when over budget)

1. Drop lowest-relevance run memories
2. Within a memory, drop sections bottom-up: Insights → Gotchas → Patterns (keep Summary)
3. Drop lowest-relevance knowledge entries
4. Truncate working context (keep file list, drop diff details)
5. Never drop: system prompt, plan context, predecessor snapshots

---

## Implementation Phases

### Phase A: Foundation (v0.2.0) — backward-compatible additions

| Task | Files | Breaking? |
|------|-------|-----------|
| Add `ContextEngine` interface + types | `core/contextEngine.ts`, `core/types.ts` | No |
| Implement `FileContextEngine` delegating to `MemoryManager` | `core/fileContextEngine.ts` | No |
| Wire `ContextEngine` into `TaskOrchestrator` (optional param, defaults to FileContextEngine) | `core/taskOrchestrator.ts` | No |
| Populate `filesModified` on `ContextSnapshot` | `core/stageDefinitions.ts` | No |
| Populate `gitInfo.filesModified` on `RunManifest` | `core/taskOrchestrator.ts` | No |
| Add `--context-budget` CLI flag (optional) | `cli/cli.ts`, `core/types.ts` | No |
| Add staleness metadata file (`.staleness.json`) | `core/stalenessTracker.ts` | No |
| Tests for all new code | `core/__tests__/contextEngine.test.ts`, etc. | No |

### Phase B: Selective Retrieval (v0.2.1) — new default

| Task | Files | Breaking? |
|------|-------|-----------|
| Three-phase retrieval scoring logic | `core/retrievalScorer.ts` | No |
| Enable selective retrieval as default in `FileContextEngine` | `core/fileContextEngine.ts` | Soft (escape hatch: `--no-selective-retrieval`) |
| Working context computation (git diff at run start) | `core/stalenessTracker.ts` | No |
| Staleness integration into retrieval scoring | `core/fileContextEngine.ts` | No |
| Tests for retrieval pipeline | `core/__tests__/retrievalScorer.test.ts` | No |

### Phase C: Knowledge Layer (v0.2.2+) — opt-in

| Task | Files | Breaking? |
|------|-------|-----------|
| Create `knowledge/` directory structure | `core/memoryManager.ts` | No |
| Knowledge extraction in distillation pipeline | `core/memoryDistiller.ts` | No |
| Knowledge merging logic | `core/fileContextEngine.ts` | No |
| `dagclaw memory migrate` command | `cli/cli.ts` | No |
| `dagclaw memory status/list/refresh` commands | `cli/cli.ts` | No |
| Update `index.md` format for knowledge + run entries | `core/memoryManager.ts` | No |

---

## Key Files

| File | Role | Changes |
|------|------|---------|
| `core/contextEngine.ts` | **NEW** — Interface + types | ContextEngine, ContextBudget, ContextEntry, CodebaseChanges, MemoryWrite |
| `core/fileContextEngine.ts` | **NEW** — Default implementation | Three-phase retrieval, budget enforcement, delegates to MemoryManager |
| `core/stalenessTracker.ts` | **NEW** — Git-based staleness | Change detection, cross-referencing, metadata management |
| `core/retrievalScorer.ts` | **NEW** — Scoring functions | Keyword matching, relevance scoring, category/recency/staleness weighting |
| `core/taskOrchestrator.ts` | Accept ContextEngine, populate filesModified, update gitInfo | Lines 174, 221, 589, 754 |
| `core/memoryDistiller.ts` | Add knowledge extraction step, accept ContextEngine | Lines 38+, 60+ |
| `core/stageDefinitions.ts` | Populate `filesModified` on ContextSnapshot | Line 347 |
| `core/memoryManager.ts` | Support `knowledge/` subdirectory, preserve API | readAll(), readSummaries(), updateIndex() |
| `core/types.ts` | New types, CliOptions extension | ContextEngine types, contextBudget option |
| `cli/cli.ts` | New flags and memory subcommands | --context-budget, memory status/migrate/refresh |

---

## Verification

1. **Unit tests**: Each new file gets comprehensive tests (contextEngine, stalenessTracker, retrievalScorer)
2. **Integration test**: Full pipeline run → verify selective retrieval produces relevant context, not full dump
3. **Staleness test**: Modify files between runs → verify stale memories are deprioritized
4. **Migration test**: Existing `.dagclaw/memory/<runId>.md` files work unchanged with new system
5. **Budget test**: Set `--context-budget 5000` → verify context block stays under limit
6. **Knowledge extraction test**: Run distillation → verify `knowledge/` files created and merged correctly
7. **Manual E2E**: Run `dagclaw "add auth endpoint"`, modify auth files manually, run `dagclaw "add rate limiting"` → verify second run gets fresh context about auth changes, relevant knowledge persists, stale run memories deprioritized
