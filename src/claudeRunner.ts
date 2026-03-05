/**
 * Claude backend runner: CLI subprocess execution, usage parsing, cost estimation.
 * SDK backend is stubbed for v0.1.0 (falls back to CLI).
 */

import { execFileSync } from 'node:child_process';
import type { ContextSnapshot, UsageStats } from './types.ts';

// --- Pricing (Sonnet 4, USD per 1M tokens) ---

const PRICE_INPUT = 3.0;
const PRICE_OUTPUT = 15.0;
const PRICE_CACHE_READ = 0.3;
const PRICE_CACHE_CREATION = 3.75;

/** Estimate USD cost from token counts. */
export function estimateCost(
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheCreationTokens: number,
): number {
  return (
    (inputTokens * PRICE_INPUT +
      outputTokens * PRICE_OUTPUT +
      cacheReadTokens * PRICE_CACHE_READ +
      cacheCreationTokens * PRICE_CACHE_CREATION) /
    1_000_000
  );
}

/** Parse usage stats from a CLI stream-json result line. */
export function parseUsageFromCliOutput(output: string): UsageStats {
  const zero: UsageStats = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    estimatedCost: 0,
    durationMs: 0,
  };

  try {
    const parsed = JSON.parse(output);
    const usage = parsed?.result?.usage ?? parsed?.usage ?? {};
    const stats: UsageStats = {
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      cacheReadTokens: usage.cache_read_input_tokens ?? 0,
      cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
      estimatedCost: 0,
      durationMs: 0,
    };
    stats.estimatedCost = estimateCost(
      stats.inputTokens,
      stats.outputTokens,
      stats.cacheReadTokens,
      stats.cacheCreationTokens,
    );
    return stats;
  } catch {
    return zero;
  }
}

/** Check if the `claude` CLI is available on PATH. */
export function checkClaudeCli(): boolean {
  try {
    execFileSync('which', ['claude'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/** Build a ContextSnapshot from structured executor output. */
export function buildSnapshotFromOutput(
  meta: { nodeId: string; stage: string; subtaskIndex?: string },
  structuredOutput: { summary?: string; oneliner?: string } | null,
  sessionId: string,
): ContextSnapshot {
  return {
    nodeId: meta.nodeId,
    stage: meta.stage,
    subtaskIndex: meta.subtaskIndex !== undefined ? Number(meta.subtaskIndex) : undefined,
    oneliner: structuredOutput?.oneliner ?? '',
    filesModified: [],
    summary: structuredOutput?.summary ?? '',
    sessionId,
  };
}
