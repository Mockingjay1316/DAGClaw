/**
 * Built-in stage definitions: Plan, Execute, Verify.
 * Each stage is a StageDefinition config with contextBuilder and resultHandler.
 * Stages differ only in config — the orchestrator loop is generic.
 */

import type {
  StageDefinition,
  SubtaskDefinition,
  PipelineState,
  Plan,
  VerificationResult,
} from './types.ts';
import {
  PlanSchema,
  ExecutorOutputSchema,
  VerificationResultSchema,
} from './types.ts';
import { parseStageOutputFile } from './claudeRunner.ts';
import { detectCircularDependencies } from './dependencyResolver.ts';

// --- Plan display & validation helpers (exported for testing) ---

/** Format a Plan as human-readable text for CLI display. */
export function formatPlanForDisplay(plan: Plan): string {
  const lines: string[] = [];
  lines.push(`[Plan] Generated plan: ${plan.subtasks.length} subtask${plan.subtasks.length !== 1 ? 's' : ''}`);
  lines.push('');
  lines.push(`  Summary: ${plan.summary}`);
  lines.push('');
  lines.push('  Subtasks:');
  for (const s of plan.subtasks) {
    const deps = s.dependencies.length > 0
      ? ` (depends on: ${s.dependencies.join(', ')})`
      : '';
    lines.push(`    [${s.index}] ${s.description} (${s.estimatedComplexity} complexity${deps})`);
  }
  if (plan.qualityFlag) {
    lines.push('');
    lines.push(`  Quality concern [${plan.qualityFlag.concern}]: ${plan.qualityFlag.message}`);
    if (plan.qualityFlag.suggestion) {
      lines.push(`  Suggestion: ${plan.qualityFlag.suggestion}`);
    }
  }
  return lines.join('\n');
}

/** Shared resource patterns to detect potential parallel conflicts. */
const SHARED_RESOURCE_PATTERNS = [
  { pattern: /\bnpm\s+(install|i|ci|update)\b/i, label: 'npm' },
  { pattern: /\byarn\s+(add|install|remove)\b/i, label: 'yarn' },
  { pattern: /\bpnpm\s+(add|install|remove)\b/i, label: 'pnpm' },
  { pattern: /\bpip\s+install\b/i, label: 'pip' },
  { pattern: /\bbundle\s+install\b/i, label: 'bundler' },
  { pattern: /\bcargo\s+(build|install)\b/i, label: 'cargo' },
];

/** Detect potential shared resource conflicts among independent subtasks. */
export function detectSharedResourceConflicts(
  subtasks: Pick<SubtaskDefinition, 'index' | 'prompt' | 'dependencies'>[],
): string[] {
  const warnings: string[] = [];
  const resourceUsers = new Map<string, number[]>();

  for (const s of subtasks) {
    for (const { pattern, label } of SHARED_RESOURCE_PATTERNS) {
      if (pattern.test(s.prompt)) {
        const users = resourceUsers.get(label) ?? [];
        users.push(s.index);
        resourceUsers.set(label, users);
      }
    }
  }

  const depOf = new Set<string>();
  for (const s of subtasks) {
    for (const dep of s.dependencies) depOf.add(`${s.index}:${dep}`);
  }

  for (const [label, users] of resourceUsers) {
    if (users.length < 2) continue;
    for (let i = 0; i < users.length; i++) {
      for (let j = i + 1; j < users.length; j++) {
        const a = users[i], b = users[j];
        if (!depOf.has(`${a}:${b}`) && !depOf.has(`${b}:${a}`)) {
          warnings.push(
            `Subtasks ${a} and ${b} both use ${label} but are independent — consider adding a dependency edge.`,
          );
        }
      }
    }
  }
  return warnings;
}

// --- Plan Stage ---

const PLAN_SYSTEM_PROMPT = `You are a planning agent for a software engineering task.

RULES:
1. Analyze the codebase and decompose the task into subtasks.
2. You are read-only — do not modify, create, or delete any files. Only use Read, Glob, and Grep tools.
3. Evaluate prompt quality. If the prompt is vague, ambiguous, overly simple, or missing important context, set the "qualityFlag" field in your output with a concern and suggestion.
4. Subtasks that modify shared resources (npm install, pip install, build commands, database migrations, shared lockfiles) MUST be marked as sequential by adding appropriate dependency edges. Two subtasks that both run package manager commands must not run in parallel.
5. Consider file dependencies when decomposing: if two subtasks modify the same files, mark one as dependent on the other.
6. Keep subtask count reasonable (soft limit: 10). If you find yourself creating more, consider whether some subtasks can be merged.
7. Set "worthDistilling" to true if this task involves non-trivial work that future runs could learn from.

Write your structured output as valid JSON to the file path provided in the task prompt.`;

const PLAN_PROMPT_TEMPLATE = `Working directory: {{workDir}}

Task: {{prompt}}

{{memoryContext}}

Write your plan as JSON to: {{outputFile}}

The JSON must conform to this schema:
{
  "summary": "brief description of the overall plan",
  "subtasks": [
    {
      "index": 0,
      "description": "what this subtask does",
      "prompt": "self-contained prompt for the executor",
      "dependencies": [],
      "estimatedComplexity": "low" | "medium" | "high",
      "needsRecursiveDecomposition": false
    }
  ],
  "qualityFlag": { "concern": "vague", "message": "...", "suggestion": "..." } | null,
  "worthDistilling": true | false
}`;

// --- Execute Stage ---

const EXECUTE_SYSTEM_PROMPT = `You are an execution agent for a software engineering subtask.

Complete the assigned subtask. You have full access to Read, Edit, Write, Bash, Glob, and Grep tools.

When you are done, write a JSON summary to the output file path provided in your prompt:
{
  "success": true,
  "summary": "paragraph describing what you did and key decisions made",
  "oneliner": "one-line description of the change"
}

Set "success" to false if you could not complete the task (e.g., permission denied, missing prerequisites, impossible constraints). Always write the output file even on failure — describe what went wrong in the summary.`;

const EXECUTE_PROMPT_TEMPLATE = `Working directory: {{workDir}}

Task: {{subtaskPrompt}}

Plan context: {{planSummary}}

{{predecessorContext}}

{{memoryContext}}

Write your summary JSON to: {{outputFile}}`;

// --- Verify Stage ---

const VERIFY_SYSTEM_PROMPT = `You are a verification agent. Review the codebase state and verify the plan was executed correctly.

RULES:
1. Generate and run your own test cases — examine the actual code and project state.
2. You receive subtask summaries (not full executor logs). If a test fails, examine the relevant code directly.
3. Use Read, Bash, Glob, and Grep tools to verify correctness.
4. For each subtask, determine if it passes verification.
5. Run an integration check to verify all subtasks work together.

Write your verification result as JSON to the output file path provided.`;

const VERIFY_PROMPT_TEMPLATE = `Working directory: {{workDir}}

Plan: {{planSummary}}

Subtask summaries:
{{subtaskSummaries}}

Skipped subtasks: {{skippedIndices}}

Write your verification result as JSON to: {{outputFile}}

The JSON must conform to this schema:
{
  "overallPass": true | false,
  "subtaskResults": [
    { "subtaskIndex": 0, "pass": true, "summary": "...", "retryRecommended": false }
  ],
  "skippedIndices": [1, 2],
  "integrationResult": { "pass": true, "summary": "...", "issues": [] }
}`;

// --- Built-in Stages ---

export const BUILTIN_STAGES: Record<string, StageDefinition> = {
  Plan: {
    name: 'Plan',
    runnerConfig: {
      systemPrompt: PLAN_SYSTEM_PROMPT,
      promptTemplate: PLAN_PROMPT_TEMPLATE,
      allowedTools: ['Read', 'Glob', 'Grep', 'Write'],
    },
    outputSchema: PlanSchema,
    approvalRequired: true,

    approvalFormatter: (state, warn) => {
      if (!state.plan) return '[Plan] No plan generated.';
      const plan = state.plan;

      const cycle = detectCircularDependencies(
        plan.subtasks.map(s => ({ index: s.index, dependencies: s.dependencies }))
      );
      if (cycle) throw new Error(`Circular dependency: ${cycle.join(' → ')}`);

      for (const w of detectSharedResourceConflicts(plan.subtasks)) {
        warn(w);
      }

      let display = formatPlanForDisplay(plan);
      if (plan.qualityFlag) {
        display += `\n\n  [Quality] ${plan.qualityFlag.message}`;
      }
      return display;
    },

    contextBuilder: (state, outputFile) => ({
      workDir: state.workDir,
      prompt: state.prompt,
      memoryContext: state.memoryContext,
      outputFile,
    }),

    resultHandler: (state, outputFile) => {
      const plan = parseStageOutputFile(PlanSchema, outputFile) as Plan | null;
      if (!plan) return '[Plan] Failed to parse plan output.';
      state.plan = plan;
      return `[Plan] Generated plan: ${plan.subtasks.length} subtask(s) — ${plan.summary}`;
    },

    formatStatus: () => '[Plan] Running...',
  },

  Execute: {
    name: 'Execute',
    runnerConfig: {
      systemPrompt: EXECUTE_SYSTEM_PROMPT,
      promptTemplate: EXECUTE_PROMPT_TEMPLATE,
    },
    outputSchema: ExecutorOutputSchema,
    parallel: true,

    subtaskExtractor: (state) => {
      if (!state.plan) return [];
      return state.plan.subtasks.map((s) => ({
        index: s.index,
        prompt: s.prompt,
        dependencies: s.dependencies,
      }));
    },

    contextBuilder: (state, outputFile, subtask) => ({
      workDir: state.workDir,
      subtaskPrompt: subtask?.prompt ?? '',
      planSummary: state.plan?.summary ?? '',
      predecessorContext: '',
      memoryContext: state.memoryContext,
      outputFile,
    }),

    resultHandler: (state, outputFile, subtask, sessionId) => {
      const output = parseStageOutputFile(ExecutorOutputSchema, outputFile) as { success: boolean; summary: string; oneliner: string } | null;
      const idx = subtask?.index ?? 0;

      // Signal failure so DAG runner can cascade-skip dependents
      if (output && !output.success) {
        throw new Error(`Subtask ${idx} failed: ${output.summary}`);
      }

      const snap = {
        nodeId: '',
        stage: 'Execute',
        subtaskIndex: idx,
        oneliner: output?.oneliner ?? '',
        filesModified: [] as string[],
        summary: output?.summary ?? '',
        sessionId: sessionId ?? '',
      };
      state.subtaskSnapshots.set(idx, snap);
      return `[Execute] [${idx}] Done: ${snap.oneliner || '(completed)'}`;
    },

    formatStatus: (subtask) =>
      `[Execute] [${subtask?.index ?? '?'}] Running...`,
  },

  Verify: {
    name: 'Verify',
    runnerConfig: {
      systemPrompt: VERIFY_SYSTEM_PROMPT,
      promptTemplate: VERIFY_PROMPT_TEMPLATE,
      allowedTools: ['Read', 'Bash', 'Glob', 'Grep', 'Write'],
    },
    outputSchema: VerificationResultSchema,

    contextBuilder: (state, outputFile) => {
      const summaries = Array.from(state.subtaskSnapshots.entries())
        .map(([idx, s]) => `[Subtask ${idx}] ${s.summary || s.oneliner || '(no summary)'}`)
        .join('\n');
      return {
        workDir: state.workDir,
        planSummary: state.plan?.summary ?? '(no plan)',
        subtaskSummaries: summaries,
        skippedIndices: state.skippedIndices.size > 0 ? Array.from(state.skippedIndices).join(', ') : 'none',
        outputFile,
      };
    },

    resultHandler: (state, outputFile) => {
      const result = parseStageOutputFile(VerificationResultSchema, outputFile) as VerificationResult | null;
      if (!result) return '[Verify] Could not parse verification result.';
      state.verification = result;
      const { pass, failedIndices } = verifyResultInterpreter(result);
      return pass
        ? '[Verify] All checks passed.'
        : `[Verify] Failed subtasks: ${failedIndices.join(', ')}`;
    },

    resultInterpreter: verifyResultInterpreter,
    retryStage: 'Execute',
    maxRetries: 2,

    formatStatus: () => '[Verify] Running...',
  },
};

// --- Helpers ---

/** Resolve a stage name to its definition. Throws if not found. */
export function getStageDefinition(name: string): StageDefinition {
  const stage = BUILTIN_STAGES[name];
  if (!stage) {
    throw new Error(`Unknown stage: "${name}". Available: ${Object.keys(BUILTIN_STAGES).join(', ')}`);
  }
  return stage;
}

/** Interpret verification output as pass/fail with failed indices. */
export function verifyResultInterpreter(output: unknown): {
  pass: boolean;
  failedIndices: number[];
} {
  const r = output as VerificationResult;
  const failedIndices = r.subtaskResults
    .filter((s) => !s.pass && s.retryRecommended)
    .map((s) => s.subtaskIndex);

  return {
    pass: r.overallPass,
    failedIndices,
  };
}
