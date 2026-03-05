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
import { parseStageOutputFile } from './claudeRunner.ts';

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
  "summary": "paragraph describing what you did and key decisions made",
  "oneliner": "one-line description of the change"
}`;

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
    approvalRequired: true,

    contextBuilder: (state, outputFile) => ({
      workDir: state.workDir,
      prompt: state.prompt,
      memoryContext: state.memoryContext,
      outputFile,
    }),

    resultHandler: (state, outputFile) => {
      const plan = parseStageOutputFile('Plan', outputFile) as Plan | null;
      if (!plan) return '[Plan] Failed to parse plan output.';
      state.plan = plan;
      return `[Plan] Generated plan: ${plan.subtasks.length} subtask(s) — ${plan.summary}`;
    },

    formatStatus: (_subtask, status) => `[Plan] ${status ?? 'Running...'}`,
  },

  Execute: {
    name: 'Execute',
    runnerConfig: {
      systemPrompt: EXECUTE_SYSTEM_PROMPT,
      promptTemplate: EXECUTE_PROMPT_TEMPLATE,
    },
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
      const output = parseStageOutputFile('Execute', outputFile) as { summary: string; oneliner: string } | null;
      const idx = subtask?.index ?? 0;
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

    formatStatus: (subtask, status) =>
      `[Execute] [${subtask?.index ?? '?'}] ${status ?? 'Running...'}`,
  },

  Verify: {
    name: 'Verify',
    runnerConfig: {
      systemPrompt: VERIFY_SYSTEM_PROMPT,
      promptTemplate: VERIFY_PROMPT_TEMPLATE,
      allowedTools: ['Read', 'Bash', 'Glob', 'Grep', 'Write'],
    },

    contextBuilder: (state, outputFile) => {
      const summaries = Array.from(state.subtaskSnapshots.entries())
        .map(([idx, s]) => `[Subtask ${idx}] ${s.summary || s.oneliner || '(no summary)'}`)
        .join('\n');
      return {
        workDir: state.workDir,
        planSummary: state.plan?.summary ?? '(no plan)',
        subtaskSummaries: summaries,
        skippedIndices: state.skippedIndices.length > 0 ? state.skippedIndices.join(', ') : 'none',
        outputFile,
      };
    },

    resultHandler: (state, outputFile) => {
      const result = parseStageOutputFile('Verify', outputFile) as VerificationResult | null;
      if (!result) return '[Verify] Could not parse verification result.';
      state.verification = result;
      const { pass, failedIndices } = verifyResultInterpreter(result);
      return pass
        ? '[Verify] All checks passed.'
        : `[Verify] Failed subtasks: ${failedIndices.join(', ')}`;
    },

    resultInterpreter: verifyResultInterpreter,
    retryStage: 'Execute',
    integrationVerifier: true,
    maxRetries: 2,

    formatStatus: (_subtask, status) => `[Verify] ${status ?? 'Running...'}`,
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

/** Extract subtask definitions from a Plan output (legacy helper). */
export function planSubtaskExtractor(plan: unknown): SubtaskDefinition[] {
  const p = plan as Plan;
  return p.subtasks.map((s) => ({
    index: s.index,
    prompt: s.prompt,
    dependencies: s.dependencies,
  }));
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
