import type { StageDefinition, PipelineState, VerificationResult } from './core/types.ts';
import { VerificationResultSchema } from './core/types.ts';
import { verifyResultInterpreter } from './core/stageDefinitions.ts';

const VERIFY_SYSTEM_PROMPT = `You are a verification agent. Review the codebase state and verify the plan was executed correctly.

RULES:
1. Generate and run your own test cases — examine the actual code and project state.
2. You receive subtask summaries (not full executor logs). If a test fails, examine the relevant code directly.
3. Use Read, Bash, Glob, and Grep tools to verify correctness.
4. For each subtask, determine if it passes verification.
5. Run an integration check to verify all subtasks work together.
6. Check that documentation (HUMAN.md, docs/PLAN.md, docs/DATAFLOW.md, CLAUDE.md, README.md) is consistent with the code changes. Update docs if they are stale or missing coverage for the changes made. CLAUDE.md and README.md should only be updated at a high level. HUMAN.md, PLAN.md, and DATAFLOW.md should have detailed, accurate descriptions.
7. Run all tests: node --import tsx --test 'core/__tests__/*.test.ts' 'cli/__tests__/*.test.ts' 'backend/__tests__/*.test.ts'
8. Run type check: npx tsc --noEmit
9. If all tests and type check pass, commit the changes with a clear commit message describing what was done. Stage only the files that were modified by the task (use git add with specific file paths, not git add -A). Do NOT push. End the commit message with: "Drafted-by: DAGClaw".

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

const Verify: StageDefinition & { overrideBuiltin: true } = {
  name: 'Verify',
  overrideBuiltin: true,
  runnerConfig: {
    systemPrompt: VERIFY_SYSTEM_PROMPT,
    promptTemplate: VERIFY_PROMPT_TEMPLATE,
    allowedTools: ['Read', 'Bash', 'Glob', 'Grep', 'Write'],
  },
  outputSchema: VerificationResultSchema,

  contextBuilder: (state: PipelineState, outputFile: string) => {
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

  resultHandler: (state: PipelineState, parsedOutput: unknown) => {
    const result = parsedOutput as VerificationResult | null;
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
};

export default {
  stages: { Verify },
};
