import type { PipelineState, CliOptions } from './types.ts';
import type { RunLogger } from './runLogger.ts';
import type { MemoryManager } from './memoryManager.ts';
import { runClaudeCli, extractTextFromStreamJson } from './claudeRunner.ts';

/**
 * Build a prompt summarizing the run results for distillation.
 */
function buildDistillationPrompt(state: PipelineState): string {
  const lines: string[] = [];

  lines.push(`## Plan Summary`);
  lines.push(state.plan!.summary);
  lines.push('');

  lines.push(`## Subtasks`);
  for (const subtask of state.plan!.subtasks) {
    const snapshot = state.subtaskSnapshots.get(subtask.index);
    const status = snapshot ? 'completed' : 'no snapshot';
    const summary = snapshot?.summary ?? 'N/A';
    lines.push(`- [${subtask.index}] ${subtask.description} — ${status}: ${summary}`);
  }
  lines.push('');

  lines.push(`## Verification`);
  if (state.verification) {
    lines.push(`Overall: ${state.verification.overallPass ? 'PASSED' : 'FAILED'}`);
    if (state.verification.integrationResult?.summary) {
      lines.push(state.verification.integrationResult.summary);
    }
  } else {
    lines.push('No verification performed.');
  }

  return lines.join('\n');
}

const DISTILLATION_SYSTEM_PROMPT = `You are a knowledge distiller. Given the results of a completed task, synthesize a structured markdown memory entry. Output ONLY the markdown content in this exact format:

# <Human-readable title describing what was done>

> <One-line summary (max 150 chars) capturing the core problem solved and key technique used. This line is used for index-based retrieval — make it precise and searchable.>

## Summary

<100-200 word narrative summary. Cover: what the task accomplished, the approach taken, key technical decisions, and outcome. Write in past tense. This section helps a model decide whether to read the full detailed memory below.>

## Key Patterns

<Specific, reusable patterns discovered. Use ### subheadings for distinct patterns. Include code snippets where they add clarity.>

## Gotchas

<Problems encountered and their solutions. Be specific about symptoms and fixes.>

## Reusable Insights

<Numbered list of actionable takeaways that apply beyond this specific task.>

IMPORTANT:
- The > blockquote line must be a single line, max 150 characters, no line breaks.
- The Summary section must be 100-200 words — not a list of bullets, but a coherent paragraph.
- Be specific and actionable throughout. Vague observations are useless.`;

/**
 * Distill memory from a completed run. Non-fatal — errors are logged but not re-thrown.
 */
export type ClaudeRunner = typeof runClaudeCli;

export async function distillMemory(
  runId: string,
  state: PipelineState,
  logger: RunLogger,
  memoryManager: MemoryManager,
  opts: CliOptions,
  runner: ClaudeRunner = runClaudeCli,
): Promise<void> {
  try {
    const prompt = buildDistillationPrompt(state);

    const result = await runner({
      prompt,
      systemPrompt: DISTILLATION_SYSTEM_PROMPT,
      workDir: opts.workDir,
      allowedTools: [],
      backend: opts.backend,
      model: opts.distillModel ?? 'sonnet',
    });

    const cleanText = extractTextFromStreamJson(result.rawOutput);

    // Save raw NDJSON as ground truth to per-run directory
    logger.appendStageLog(runId, 'memory-distillation', result.rawOutput);

    // Save clean per-run memory
    logger.writeRunMemory(runId, cleanText);

    // Write to project memory with run ID filename
    const filename = `${runId}.md`;
    memoryManager.writeFile(filename, cleanText);

    // Regenerate the memory index for progressive disclosure
    memoryManager.updateIndex();
  } catch (err) {
    const msg = `[memoryDistiller] Memory distillation failed: ${err instanceof Error ? err.message : String(err)}\n`;
    process.stderr.write(msg);
  }
}
