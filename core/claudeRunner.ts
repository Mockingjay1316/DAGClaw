/**
 * Claude backend runner: CLI subprocess execution, usage parsing, cost estimation,
 * structured output parsing, and prompt building for stages.
 */

import { spawn, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { RunnerBackend, UsageStats } from './types.ts';
import { interpolateTemplate } from './promptBuilder.ts';

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

// --- Stage prompt building ---

/** Build the prompt for a stage by interpolating its template with context. */
export function buildStagePrompt(promptTemplate: string, context: Record<string, string>): string {
  return interpolateTemplate(promptTemplate, context);
}

// --- Structured output parsing ---

/** Parse raw JSON string against a Zod schema. */
export function parseStageOutput(schema: { parse: (data: unknown) => unknown }, raw: string): unknown | null {
  try {
    return schema.parse(JSON.parse(raw));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[parseStageOutput] validation failed: ${msg.slice(0, 300)}\n`);
    return null;
  }
}

/** Parse a structured output file against a Zod schema. */
export function parseStageOutputFile(schema: { parse: (data: unknown) => unknown }, filePath: string): unknown | null {
  try {
    return parseStageOutput(schema, readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

// --- Error class with partial output ---

/** Error thrown when Claude CLI fails, preserving any partial output. */
export class ClaudeRunError extends Error {
  public readonly partialOutput: string;
  public readonly exitCode: number | null;

  constructor(message: string, partialOutput: string, exitCode: number | null = null) {
    super(message);
    this.name = 'ClaudeRunError';
    this.partialOutput = partialOutput;
    this.exitCode = exitCode;
  }
}

// --- Claude CLI execution ---

export interface RunClaudeOptions {
  prompt: string;
  systemPrompt: string;
  workDir: string;
  allowedTools?: string[];
  timeoutMs?: number;
  backend: RunnerBackend;
  dangerouslySkipPermissions?: boolean;
  model?: string;
}

export interface RunClaudeResult {
  rawOutput: string;
  sessionId: string;
  usage: UsageStats;
}

/** Build the CLI args array from options (exported for testing). */
export function buildCliArgs(options: RunClaudeOptions): string[] {
  const args = ['-p', '--verbose', '--output-format', 'stream-json'];

  if (options.allowedTools?.length) {
    for (const tool of options.allowedTools) {
      args.push('--allowedTools', tool);
    }
  }

  if (options.dangerouslySkipPermissions) {
    args.push('--dangerously-skip-permissions');
  }

  if (options.model) {
    args.push('--model', options.model);
  }

  args.push('--system-prompt', options.systemPrompt);
  return args;
}

/** Spawn `claude -p` and collect output. */
export async function runClaudeCli(options: RunClaudeOptions): Promise<RunClaudeResult> {
  const args = buildCliArgs(options);

  return new Promise<RunClaudeResult>((resolve, reject) => {
    const child = spawn('claude', args, {
      cwd: options.workDir,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    child.stdin.write(options.prompt);
    child.stdin.end();

    let timer: ReturnType<typeof setTimeout> | undefined;
    if (options.timeoutMs) {
      timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new ClaudeRunError(
          `Claude CLI timed out after ${options.timeoutMs}ms`,
          stdout,
          null,
        ));
      }, options.timeoutMs);
    }

    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (code !== 0 && code !== null) {
        reject(new ClaudeRunError(
          `Claude CLI exited with code ${code}: ${stderr}`,
          stdout,
          code,
        ));
        return;
      }

      const lines = stdout.trim().split('\n');
      let usage = parseUsageFromCliOutput('{}');
      let sessionId = '';

      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.type === 'result') {
            usage = parseUsageFromCliOutput(line);
            sessionId = parsed.session_id ?? parsed.sessionId ?? '';
          }
        } catch { /* skip non-json lines */ }
      }

      resolve({ rawOutput: stdout, sessionId, usage });
    });

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
  });
}
