/**
 * Task orchestration: generic pipeline driver, DAG scheduling, concurrency control.
 * The orchestrator knows nothing about specific stages — it reads StageDefinition
 * configs and executes them uniformly via a single execution primitive (runOne).
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type {
  CliOptions,
  PipelineState,
  Plan,
  SubtaskDefinition,
  StageDefinition,
  UsageStats,
} from './types.ts';
import { DependencyResolver, detectCircularDependencies } from './dependencyResolver.ts';
import { getStageDefinition } from './stageDefinitions.ts';
import { RunLogger } from './runLogger.ts';
import { MemoryManager } from './memoryManager.ts';
import { acquireLock, releaseLock, checkStaleLock } from './taskManager.ts';
import { buildStagePrompt, checkClaudeCli, runClaudeCli } from './claudeRunner.ts';

// --- Pure utility functions (exported for testing) ---

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

/** Aggregate multiple UsageStats into a single total. */
export function aggregateUsage(stats: UsageStats[]): UsageStats {
  const total: UsageStats = {
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
    cacheCreationTokens: 0, estimatedCost: 0, durationMs: 0,
  };
  for (const s of stats) {
    total.inputTokens += s.inputTokens;
    total.outputTokens += s.outputTokens;
    total.cacheReadTokens += s.cacheReadTokens;
    total.cacheCreationTokens += s.cacheCreationTokens;
    total.estimatedCost += s.estimatedCost;
    total.durationMs += s.durationMs;
  }
  return total;
}

/** Check if a directory is a git repository. */
export function isGitRepo(dir: string): boolean {
  return existsSync(join(dir, '.git'));
}

/** Get files modified since last commit (unstaged + staged). */
export function getFilesModifiedByGit(dir: string): string[] {
  try {
    const output = execFileSync('git', ['diff', '--name-only', 'HEAD'], {
      cwd: dir, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8',
    });
    return output.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

// --- Orchestrator callbacks ---

export interface OrchestratorCallbacks {
  onApprovalRequest?: (message: string) => Promise<boolean>;
  onStatus?: (message: string) => void;
  onWarning?: (message: string) => void;
}

// --- TaskOrchestrator ---

export class TaskOrchestrator {
  private opts: CliOptions;
  private logger: RunLogger;
  private memory: MemoryManager;
  private cb: OrchestratorCallbacks;
  private isShuttingDown = false;

  constructor(opts: CliOptions, cb: OrchestratorCallbacks = {}) {
    this.opts = opts;
    this.logger = new RunLogger(opts.workDir);
    this.memory = new MemoryManager(opts.workDir);
    this.cb = cb;
  }

  private status(msg: string) { this.cb.onStatus?.(msg); }
  private warn(msg: string) { this.cb.onWarning?.(msg); }

  /** Run the full pipeline. */
  async run(): Promise<{ runId: string; success: boolean }> {
    const stale = checkStaleLock(this.opts.workDir);
    if (stale) this.warn(`Cleaned up stale lock from PID ${stale}`);

    if (this.opts.backend.type === 'cli' && !checkClaudeCli()) {
      throw new Error('Claude Code CLI not found. Install from https://docs.anthropic.com/claude-code');
    }

    const gitInfo = isGitRepo(this.opts.workDir) ? this.captureGitInfo() : undefined;
    const runId = this.logger.initRun({
      prompt: this.opts.prompt, pipeline: this.opts.pipeline,
      backend: this.opts.backend.type, permissionMode: this.opts.permissionMode, gitInfo,
    });
    acquireLock(this.opts.workDir, runId);
    this.logger.cleanTmp();

    const state: PipelineState = {
      prompt: this.opts.prompt, workDir: this.opts.workDir,
      plan: null, subtaskSnapshots: new Map(), skippedIndices: [],
      memoryContext: this.opts.noMemory ? '' : this.memory.buildContextBlock(),
      verification: null,
    };

    this.status(`[Run ${runId}] Pipeline: ${this.opts.pipeline.join(' → ')}`);

    try {
      for (const stageName of this.opts.pipeline) {
        if (this.isShuttingDown) break;
        const stage = getStageDefinition(stageName);

        if (stage.parallel && stage.subtaskExtractor) {
          const subtasks = stage.subtaskExtractor(state);
          if (subtasks.length === 0) {
            this.status(`[${stageName}] No subtasks — skipping.`);
            continue;
          }
          await this.runDAG(runId, stage, state, subtasks);
        } else {
          await this.runOne(runId, stage, state);
        }

        if (stage.approvalRequired && !this.opts.autoApprove && state.plan) {
          const approved = await this.approvePlan(stageName, state.plan);
          if (!approved) {
            this.logger.updateManifestStatus(runId, 'cancelled');
            return { runId, success: false };
          }
        }

        // Generic retry loop: if resultInterpreter reports failure and
        // retryStage is configured, re-run that stage for failed indices,
        // then re-run this stage to re-check. Up to maxRetries times.
        if (stage.resultInterpreter && state.verification) {
          this.logger.writeVerification(runId, state.verification);
          const result = await this.retryLoop(runId, stage, state);
          if (!result) {
            this.logger.updateManifestStatus(runId, 'failed');
            this.printCostSummary(runId);
            return { runId, success: false };
          }
        }
      }

      this.logger.updateManifestStatus(runId, 'completed');
      this.printCostSummary(runId);
      return { runId, success: true };
    } catch (err) {
      this.logger.updateManifestStatus(runId, 'failed');
      throw err;
    } finally {
      releaseLock(this.opts.workDir);
    }
  }

  /**
   * Single execution primitive. Runs one Claude invocation — whether it's
   * a standalone stage (Plan, Verify) or one subtask within a parallel stage.
   */
  private async runOne(
    runId: string,
    stage: StageDefinition,
    state: PipelineState,
    subtask?: SubtaskDefinition,
  ): Promise<string> {
    const fileLabel = subtask !== undefined
      ? `subtask-${subtask.index}-summary`
      : stage.name.toLowerCase();
    const outputFile = this.logger.tmpPath(`${fileLabel}.json`);
    const context = stage.contextBuilder(state, outputFile, subtask);
    const prompt = buildStagePrompt(stage.runnerConfig.promptTemplate!, context);
    const systemPrompt = stage.runnerConfig.systemPrompt!;

    this.logger.logStagePrompt(runId, stage.name, prompt, systemPrompt, subtask?.index);
    this.status(stage.formatStatus?.(subtask) ?? `[${stage.name}] Running...`);

    const result = await runClaudeCli({
      prompt,
      systemPrompt,
      workDir: state.workDir,
      allowedTools: stage.runnerConfig.allowedTools,
      timeoutMs: this.opts.timeoutSeconds * 1000,
      backend: this.opts.backend,
      dangerouslySkipPermissions: true,  // always skip in CLI -p mode; tools restricted via allowedTools
    });

    if (subtask !== undefined) {
      this.logger.updateSubtaskUsage(runId, subtask.index, result.usage);
      this.logger.appendSubtaskLog(runId, subtask.index, result.rawOutput);
    } else {
      this.logger.updateStageUsage(runId, stage.name, result.usage);
      this.logger.appendStageLog(runId, stage.name, result.rawOutput);
    }

    return stage.resultHandler(state, outputFile, subtask, result.sessionId);
  }

  /** Schedule subtasks via DAG, running ready ones in parallel up to maxConcurrency. */
  private async runDAG(
    runId: string,
    stage: StageDefinition,
    state: PipelineState,
    subtasks: SubtaskDefinition[],
  ): Promise<void> {
    const resolver = new DependencyResolver(subtasks);
    const byIndex = new Map(subtasks.map(s => [s.index, s]));

    this.status(`[${stage.name}] ${subtasks.length} subtask(s), max concurrency ${this.opts.maxConcurrency}`);

    while (!resolver.allComplete() && !this.isShuttingDown) {
      const ready = resolver.getReady();
      if (ready.length === 0) break;

      const batch = ready.slice(0, this.opts.maxConcurrency);
      const results = await Promise.allSettled(
        batch.map(idx => this.runOne(runId, stage, state, byIndex.get(idx)!))
      );

      for (let i = 0; i < batch.length; i++) {
        const idx = batch[i];
        if (results[i].status === 'fulfilled') {
          resolver.markComplete(idx);
          this.status((results[i] as PromiseFulfilledResult<string>).value);
        } else {
          const reason = (results[i] as PromiseRejectedResult).reason;
          this.status(`[${stage.name}] [${idx}] Failed: ${reason?.message || 'unknown'}`);
          resolver.markSkipped(idx);
          state.skippedIndices.push(idx);
          // Report cascade
          for (const s of subtasks) {
            if (resolver.isSkipped(s.index) && s.index !== idx && !state.skippedIndices.includes(s.index)) {
              state.skippedIndices.push(s.index);
              this.status(`[${stage.name}] [${s.index}] Skipped (cascade from ${idx})`);
            }
          }
        }
      }
    }
  }

  /** Validate plan and prompt for approval. */
  private async approvePlan(stageName: string, plan: Plan): Promise<boolean> {
    const cycle = detectCircularDependencies(
      plan.subtasks.map(s => ({ index: s.index, dependencies: s.dependencies }))
    );
    if (cycle) throw new Error(`Circular dependency: ${cycle.join(' → ')}`);

    for (const w of detectSharedResourceConflicts(plan.subtasks)) {
      this.warn(`[${stageName}] ${w}`);
    }

    this.status(formatPlanForDisplay(plan));
    if (plan.qualityFlag) this.status(`\n  [Quality] ${plan.qualityFlag.message}`);

    const ok = await this.cb.onApprovalRequest?.('\n  Approve plan? (y/n): ');
    if (!ok) { this.status(`[${stageName}] Rejected.`); return false; }
    return true;
  }

  /**
   * Generic retry loop driven by stage config.
   * Returns true if the stage eventually passes, false if retries exhausted.
   */
  private async retryLoop(
    runId: string,
    stage: StageDefinition,
    state: PipelineState,
  ): Promise<boolean> {
    const maxRetries = stage.maxRetries ?? this.opts.maxRetries;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const interpreted = stage.resultInterpreter!(state.verification!);

      if (interpreted.pass) {
        this.status(`[${stage.name}] All checks passed.`);
        return true;
      }

      const failedIndices = interpreted.failedIndices ?? [];
      this.logStageFailure(stage.name, state, failedIndices);

      // No retryStage configured or no retryable indices — fail immediately
      if (!stage.retryStage || failedIndices.length === 0 || attempt >= maxRetries) {
        if (attempt >= maxRetries && failedIndices.length > 0) {
          this.status(`[${stage.name}] Max retries (${maxRetries}) reached.`);
        }
        return false;
      }

      // Re-run the configured retry stage for failed indices only
      this.status(`[${stage.name}] Re-executing ${failedIndices.length} subtask(s) via ${stage.retryStage} (attempt ${attempt + 1}/${maxRetries})...`);
      const retryStage = getStageDefinition(stage.retryStage);
      const allSubtasks = retryStage.subtaskExtractor?.(state) ?? [];
      const retrySubtasks = allSubtasks.filter(s => failedIndices.includes(s.index));

      for (const subtask of retrySubtasks) {
        if (this.isShuttingDown) return false;
        const msg = await this.runOne(runId, retryStage, state, subtask);
        this.status(msg);
      }

      // Re-run this stage to re-check
      this.status(`[${stage.name}] Re-checking...`);
      state.verification = null;
      await this.runOne(runId, stage, state);
      if (state.verification) {
        this.logger.writeVerification(runId, state.verification);
      }
    }
    return false;
  }

  private logStageFailure(stageName: string, state: PipelineState, failedIndices: number[]): void {
    this.status(`[${stageName}] Failed.`);
    const v = state.verification;
    if (!v) return;
    for (const sr of v.subtaskResults) {
      if (!sr.pass) {
        const retry = sr.retryRecommended ? ' (will retry)' : '';
        this.status(`[${stageName}] [${sr.subtaskIndex}] ${sr.summary}${retry}`);
      }
    }
    if (!v.integrationResult.pass) {
      this.status(`[${stageName}] Integration: ${v.integrationResult.summary}`);
      for (const issue of v.integrationResult.issues) {
        this.status(`[${stageName}]   - ${issue}`);
      }
    }
  }

  // --- Lifecycle ---

  private printCostSummary(runId: string): void {
    try {
      const m = this.logger.readManifest(runId);
      this.status('\n--- Cost Summary ---');
      this.status(`  Input tokens:  ${m.usage.totalInputTokens.toLocaleString()}`);
      this.status(`  Output tokens: ${m.usage.totalOutputTokens.toLocaleString()}`);
      this.status(`  Cache tokens:  ${m.usage.totalCacheTokens.toLocaleString()}`);
      this.status(`  Estimated cost: $${m.usage.estimatedCost.toFixed(4)}`);
      if (m.duration) this.status(`  Duration: ${(m.duration / 1000).toFixed(1)}s`);
    } catch { /* best effort */ }
  }

  private captureGitInfo() {
    try {
      const run = (args: string[]) => execFileSync('git', args, {
        cwd: this.opts.workDir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      return {
        branch: run(['rev-parse', '--abbrev-ref', 'HEAD']),
        commitBefore: run(['rev-parse', 'HEAD']),
        commitAfter: null as string | null,
        filesModified: [] as string[],
      };
    } catch {
      return { branch: 'unknown', commitBefore: 'unknown', commitAfter: null as string | null, filesModified: [] as string[] };
    }
  }

  shutdown(): void { this.isShuttingDown = true; }

  setupSignalHandlers(): void {
    let forceCount = 0;
    const handler = () => {
      if (++forceCount >= 2) process.exit(1);
      this.status('\nShutting down... (Ctrl+C again to force)');
      this.shutdown();
    };
    process.on('SIGINT', handler);
    process.on('SIGTERM', handler);
  }
}
