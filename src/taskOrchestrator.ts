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
  Plan,
  Subtask,
  PipelineState,
  SubtaskDefinition,
  StageDefinition,
  UsageStats,
} from './types.ts';
import { DependencyResolver } from './dependencyResolver.ts';
import { getStageDefinition } from './stageDefinitions.ts';
import { RunLogger } from './runLogger.ts';
import { MemoryManager } from './memoryManager.ts';
import { acquireLock, releaseLock, checkStaleLock } from './taskManager.ts';
import { buildStagePrompt, checkClaudeCli, runClaudeCli, parseStageOutputFile } from './claudeRunner.ts';

// --- Pure utility functions (exported for testing) ---

/** Aggregate multiple UsageStats into a single total. */
export function aggregateUsage(stats: UsageStats[]): UsageStats {
  const total: UsageStats = {
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
    cacheCreationTokens: 0, estimatedCost: 0,
  };
  for (const s of stats) {
    total.inputTokens += s.inputTokens;
    total.outputTokens += s.outputTokens;
    total.cacheReadTokens += s.cacheReadTokens;
    total.cacheCreationTokens += s.cacheCreationTokens;
    total.estimatedCost += s.estimatedCost;
  }
  return total;
}

/** Check if a directory is a git repository. */
export function isGitRepo(dir: string): boolean {
  return existsSync(join(dir, '.git'));
}

/** Check if a subtask needs recursive decomposition. */
export function shouldRecurse(subtaskIndex: number, plan: Plan): boolean {
  return plan.subtasks.find(s => s.index === subtaskIndex)?.needsRecursiveDecomposition === true;
}

/** Build CliOptions for a child recursive task from a parent's options and subtask. */
export function buildChildOptions(parentOpts: CliOptions, subtask: Subtask, currentDepth: number): CliOptions {
  if (currentDepth >= parentOpts.maxDepth) {
    throw new Error(`Max recursion depth (${parentOpts.maxDepth}) reached`);
  }
  return {
    prompt: subtask.prompt,
    workDir: parentOpts.workDir,
    pipeline: ['Plan', 'Execute', 'Verify'],
    backend: parentOpts.backend,
    permissionMode: parentOpts.permissionMode,
    autoApprove: true,
    maxRetries: parentOpts.maxRetries,
    maxConcurrency: parentOpts.maxConcurrency,
    maxDepth: parentOpts.maxDepth,
    timeoutSeconds: parentOpts.timeoutSeconds,
    noSummary: true,
    noMemory: parentOpts.noMemory,
  };
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
  private depth: number;
  private isChild: boolean;

  constructor(opts: CliOptions, cb: OrchestratorCallbacks = {}, depth: number = 0, logger?: RunLogger) {
    this.opts = opts;
    this.logger = logger ?? new RunLogger(opts.workDir);
    this.memory = new MemoryManager(opts.workDir);
    this.cb = cb;
    this.depth = depth;
    this.isChild = depth > 0;
  }

  private status(msg: string) { this.cb.onStatus?.(msg); }
  private warn(msg: string) { this.cb.onWarning?.(msg); }

  /** Run the full pipeline. */
  async run(): Promise<{ runId: string; success: boolean }> {
    if (!this.isChild) {
      const stale = checkStaleLock(this.opts.workDir);
      if (stale) this.warn(`Cleaned up stale lock from PID ${stale.pid}`);
    }

    if (this.opts.backend.type === 'cli' && !checkClaudeCli()) {
      throw new Error('Claude Code CLI not found. Install from https://docs.anthropic.com/claude-code');
    }

    const gitInfo = isGitRepo(this.opts.workDir) ? this.captureGitInfo() : undefined;
    const runId = this.logger.initRun({
      prompt: this.opts.prompt, pipeline: this.opts.pipeline,
      backend: this.opts.backend.type, permissionMode: this.opts.permissionMode, gitInfo,
    });
    if (!this.isChild) acquireLock(this.opts.workDir, runId);
    this.logger.cleanTmp();

    const state: PipelineState = {
      prompt: this.opts.prompt, workDir: this.opts.workDir,
      plan: null, subtaskSnapshots: new Map(), skippedIndices: new Set(),
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

        if (stage.approvalRequired && !this.opts.autoApprove) {
          const approved = await this.requestApproval(stage, state);
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
            if (!this.opts.noSummary) this.printCostSummary(runId);
            return { runId, success: false };
          }
        }
      }

      this.logger.updateManifestStatus(runId, 'completed');
      if (!this.opts.noSummary) this.printCostSummary(runId);
      return { runId, success: true };
    } catch (err) {
      this.logger.updateManifestStatus(runId, 'failed');
      throw err;
    } finally {
      if (!this.isChild) releaseLock(this.opts.workDir);
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
    const prompt = buildStagePrompt(stage.runnerConfig.promptTemplate, context);
    const systemPrompt = stage.runnerConfig.systemPrompt;

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

    // Validate structured output via declared schema
    const parsedOutput = stage.outputSchema
      ? parseStageOutputFile(stage.outputSchema, outputFile)
      : null;

    return stage.resultHandler(state, parsedOutput, subtask, result.sessionId);
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
        batch.map(idx => {
          if (shouldRecurse(idx, state.plan!)) {
            return this.runRecursive(runId, stage, state, byIndex.get(idx)!);
          }
          return this.runOne(runId, stage, state, byIndex.get(idx)!);
        })
      );

      for (let i = 0; i < batch.length; i++) {
        const idx = batch[i];
        if (results[i].status === 'fulfilled') {
          resolver.markComplete(idx);
          this.status((results[i] as PromiseFulfilledResult<string>).value);
        } else {
          const reason = (results[i] as PromiseRejectedResult).reason;
          this.status(`[${stage.name}] [${idx}] Failed: ${reason?.message || 'unknown'}`);
          const cascaded = resolver.markSkipped(idx);
          state.skippedIndices.add(idx);
          for (const cascadedIdx of cascaded) {
            state.skippedIndices.add(cascadedIdx);
            this.status(`[${stage.name}] [${cascadedIdx}] Skipped (cascade from ${idx})`);
          }
        }
      }
    }
  }

  /** Recursively decompose a subtask by spawning a child orchestrator. */
  private async runRecursive(
    runId: string,
    stage: StageDefinition,
    state: PipelineState,
    subtask: SubtaskDefinition,
  ): Promise<string> {
    const idx = subtask.index;
    this.status(`[${stage.name}] [${idx}] Recursively decomposing (depth ${this.depth + 1})...`);

    const planSubtask = state.plan!.subtasks.find(s => s.index === idx)!;
    const childOpts = buildChildOptions(this.opts, planSubtask, this.depth);
    const childLogger = this.logger.createChildLogger(runId);
    const child = new TaskOrchestrator(childOpts, this.cb, this.depth + 1, childLogger);

    const result = await child.run();

    if (!result.success) {
      throw new Error(`Recursive subtask ${idx} failed (child run ${result.runId})`);
    }

    // Record a ContextSnapshot for the completed recursive subtask
    const snapshot = {
      nodeId: result.runId,
      stage: stage.name,
      subtaskIndex: idx,
      oneliner: `Subtask ${idx} completed via recursive decomposition`,
      filesModified: [],
      summary: `Subtask ${idx} completed via recursive decomposition (depth ${this.depth + 1})`,
      sessionId: result.runId,
    };
    state.subtaskSnapshots.set(idx, snapshot);

    return `[${stage.name}] [${idx}] Recursive decomposition complete.`;
  }

  /** Display stage result and prompt for approval. */
  private async requestApproval(stage: StageDefinition, state: PipelineState): Promise<boolean> {
    if (stage.approvalFormatter) {
      this.status(stage.approvalFormatter(state));
    }

    const ok = await this.cb.onApprovalRequest?.(`\n  Approve ${stage.name.toLowerCase()}? (y/n): `);
    if (!ok) { this.status(`[${stage.name}] Rejected.`); return false; }
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
      this.status(`  Cache tokens:  ${m.usage.totalCacheReadTokens.toLocaleString()}`);
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
