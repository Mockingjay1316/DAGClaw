import type { PipelineState, CliOptions } from './types.ts';
import type { RunLogger } from './runLogger.ts';
import type { MemoryManager } from './memoryManager.ts';
import { runClaudeCli } from './claudeRunner.ts';

/**
 * Convert text to a URL-safe slug.
 * Lowercase, replace non-alphanumeric with hyphens, collapse, trim, truncate to 50 chars.
 */
export function slugify(text: string): string {
  let slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');

  if (slug.length > 50) {
    slug = slug.slice(0, 50).replace(/-$/, '');
  }

  return slug || 'untitled';
}

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

const DISTILLATION_SYSTEM_PROMPT =
  'You are a knowledge distiller. Given the results of a completed task, synthesize a concise markdown memory entry capturing: key patterns discovered, what worked well, gotchas encountered, and reusable insights. Be specific and actionable. Output ONLY the markdown content.';

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

    const filename = `${slugify(state.plan!.summary)}.md`;
    memoryManager.writeFile(filename, result.rawOutput);
  } catch (err) {
    const msg = `Memory distillation failed: ${err instanceof Error ? err.message : String(err)}`;
    if (typeof (logger as any).warn === 'function') {
      (logger as any).warn(msg);
    }
  }
}
