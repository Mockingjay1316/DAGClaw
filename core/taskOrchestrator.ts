/**
 * Task orchestration: generic pipeline driver, DAG scheduling, concurrency control.
 * The orchestrator knows nothing about specific stages — it reads StageDefinition
 * configs and executes them uniformly via a single execution primitive (runOne).
 */

import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  CliOptions,
  DAGEvent,
  Plan,
  Subtask,
  PipelineState,
  SubtaskDefinition,
  StageDefinition,
  UsageStats,
} from './types.ts';
import { SubtaskError } from './types.ts';
import { DependencyResolver } from './dependencyResolver.ts';
import { getStageDefinition, formatStageDescriptions } from './stageDefinitions.ts';
import { RunLogger } from './runLogger.ts';
import { MemoryManager } from './memoryManager.ts';
import { acquireLock, releaseLock, checkStaleLock } from './taskManager.ts';
import { buildStagePrompt, checkClaudeCli, runClaudeCli, parseStageOutputFile, ClaudeRunError, extractFailureFromRawOutput } from './claudeRunner.ts';
import { distillMemory } from './memoryDistiller.ts';

// --- Pure utility functions (exported for testing) ---

/** Format token count: "18.2k" for >= 1000, raw number otherwise. */
export function formatTokenCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/** Format duration in ms: "3m 24s" or "45s". */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

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
    dagStages: parentOpts.dagStages,
    model: parentOpts.model,
    dagModel: parentOpts.dagModel,
    maxSubtaskRetries: parentOpts.maxSubtaskRetries,
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

/**
 * Resolve the model to use for a stage, with precedence:
 * 1. Stage's own runnerConfig.model (most specific)
 * 2. dagModel (only for parallel stages)
 * 3. Global model
 * 4. undefined (Claude CLI default)
 */
export function resolveModel(
  stageModel: string | undefined,
  isParallel: boolean,
  dagModel: string | undefined,
  globalModel: string | undefined,
): string | undefined {
  return stageModel ?? (isParallel ? dagModel : undefined) ?? globalModel;
}

/**
 * Determine if a subtask failure is worth retrying.
 * Checks both the executor output (retryWorthy field) and the error type.
 * ClaudeRunError (transient CLI/process failure) always takes precedence.
 */
export function isRetryWorthy(output: unknown, err: unknown): boolean {
  // ClaudeRunError = transient CLI/process failure, always retryable
  if (err instanceof ClaudeRunError) return true;
  // Also check by name for duck-typing compatibility
  if (err instanceof Error && err.name === 'ClaudeRunError') return true;

  // Check executor output's retryWorthy flag
  if (output && typeof output === 'object' && 'retryWorthy' in output) {
    return !!(output as { retryWorthy?: boolean }).retryWorthy;
  }

  return false;
}

// --- Orchestrator callbacks ---

export interface OrchestratorCallbacks {
  onApprovalRequest?: (message: string) => Promise<boolean>;
  onStatus?: (message: string) => void;
  onWarning?: (message: string) => void;
  onDAGEvent?: (event: DAGEvent) => void;
  onStageStart?: (label: string, stageName?: string) => void;
  onStageEnd?: () => void;
  onPlanReady?: (plan: Plan) => void;
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
  private stageRegistry?: Record<string, StageDefinition>;

  /** The current run ID, set early in run() for external access. */
  public currentRunId: string | null = null;

  constructor(opts: CliOptions, cb: OrchestratorCallbacks = {}, depth: number = 0, logger?: RunLogger, stageRegistry?: Record<string, StageDefinition>) {
    this.opts = opts;
    this.logger = logger ?? new RunLogger(opts.workDir);
    this.memory = new MemoryManager(opts.workDir);
    this.cb = cb;
    this.depth = depth;
    this.isChild = depth > 0;
    this.stageRegistry = stageRegistry;
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
      taskNumber: this.opts.taskNumber,
    });
    this.currentRunId = runId;

    try {
      if (!this.isChild) acquireLock(this.opts.workDir, runId);
      this.logger.cleanTmp();

      const executeIdx = this.opts.pipeline.indexOf('Execute');
      const postStages = executeIdx >= 0
        ? this.opts.pipeline.slice(executeIdx + 1)
        : [];

      const state: PipelineState = {
        prompt: this.opts.prompt, workDir: this.opts.workDir,
        plan: null, subtaskSnapshots: new Map(), skippedIndices: new Set(),
        memoryContext: this.opts.noMemory ? '' : this.memory.buildContextBlock(),
        verification: null,
        dagPalette: this.opts.dagStages,
        postStages,
        stageDescriptions: formatStageDescriptions(this.opts.dagStages, this.stageRegistry),
      };

      this.status(`[Run ${runId}] Pipeline: ${this.opts.pipeline.join(' → ')}`);
      for (const stageName of this.opts.pipeline) {
        if (this.isShuttingDown) break;
        const stage = getStageDefinition(stageName, this.stageRegistry);

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

        // Notify listeners when plan is ready (before approval prompt)
        if (state.plan && this.cb.onPlanReady) {
          this.cb.onPlanReady(state.plan);
          this.cb.onPlanReady = undefined; // fire once
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
      if (state.plan?.worthDistilling && !this.opts.noMemory) {
        try {
          await distillMemory(runId, state, this.logger, this.memory, this.opts);
        } catch (e: any) {
          console.warn('Memory distillation failed (non-fatal):', e.message);
        }
      }
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
    const systemPrompt = buildStagePrompt(stage.runnerConfig.systemPrompt, context);

    this.logger.logStagePrompt(runId, stage.name, prompt, systemPrompt, subtask?.index);
    const statusLabel = stage.formatStatus?.(subtask) ?? `[${stage.name}] Running...`;

    if (subtask && this.cb.onDAGEvent) {
      // DAG display handles subtask rendering
    } else if (!subtask && this.cb.onStageStart) {
      // Standalone stage: start live ticker
      this.cb.onStageStart(statusLabel, stage.name);
    } else {
      this.status(statusLabel);
    }

    const resolvedModel = resolveModel(
      stage.runnerConfig.model, !!stage.parallel, this.opts.dagModel, this.opts.model,
    );

    let result;
    try {
      result = await runClaudeCli({
        prompt,
        systemPrompt,
        workDir: state.workDir,
        allowedTools: stage.runnerConfig.allowedTools,
        timeoutMs: this.opts.timeoutSeconds * 1000,
        backend: this.opts.backend,
        dangerouslySkipPermissions: true,  // always skip in CLI -p mode; tools restricted via allowedTools
        model: resolvedModel,
      });
    } catch (err) {
      // Stop standalone stage ticker on failure too
      if (!subtask && this.cb.onStageEnd) {
        this.cb.onStageEnd();
      }
      // Save partial output on Claude CLI failure
      if (err instanceof ClaudeRunError && err.partialOutput) {
        if (subtask !== undefined) {
          this.logger.appendSubtaskLog(runId, subtask.index, err.partialOutput);
        } else {
          this.logger.appendStageLog(runId, stage.name, err.partialOutput);
        }
      }
      throw err;
    }

    // Stop standalone stage ticker
    if (!subtask && this.cb.onStageEnd) {
      this.cb.onStageEnd();
    }

    if (subtask !== undefined) {
      this.logger.updateSubtaskUsage(runId, subtask.index, result.usage);
      this.logger.appendSubtaskLog(runId, subtask.index, result.rawOutput);
    } else {
      this.logger.updateStageUsage(runId, stage.name, result.usage);
      this.logger.appendStageLog(runId, stage.name, result.rawOutput);
    }

    // Validate structured output via declared schema
    let parsedOutput = stage.outputSchema
      ? parseStageOutputFile(stage.outputSchema, outputFile)
      : null;

    // Fallback: if JSON parse failed, try to detect failure patterns from raw output
    // and write a synthetic failure JSON so downstream handlers get structured data
    if (stage.outputSchema && !parsedOutput && result.rawOutput) {
      const fallback = extractFailureFromRawOutput(result.rawOutput);
      if (fallback) {
        try {
          writeFileSync(outputFile, JSON.stringify(fallback, null, 2));
          parsedOutput = stage.outputSchema.parse(fallback);
        } catch {
          // Fallback itself didn't match schema — let parsedOutput remain null
        }
      }
    }

    return stage.resultHandler(state, parsedOutput, subtask, result.sessionId);
  }

  private emitDAG(event: DAGEvent): void {
    this.cb.onDAGEvent?.(event);
  }

  /** Schedule subtasks via DAG with greedy scheduling — launches tasks as slots free up. */
  private async runDAG(
    runId: string,
    stage: StageDefinition,
    state: PipelineState,
    subtasks: SubtaskDefinition[],
  ): Promise<void> {
    const resolver = new DependencyResolver(subtasks);
    const byIndex = new Map(subtasks.map(s => [s.index, s]));
    const hasDAGDisplay = !!this.cb.onDAGEvent;

    this.status(`[${stage.name}] ${subtasks.length} subtask(s), max concurrency ${this.opts.maxConcurrency}`);

    // Emit dag-start with subtask info from the plan
    const planSubtasks = state.plan?.subtasks ?? [];
    this.emitDAG({
      type: 'dag-start',
      subtasks: subtasks.map(s => {
        const planEntry = planSubtasks.find(p => p.index === s.index);
        return {
          index: s.index,
          description: planEntry?.description ?? s.prompt.slice(0, 60),
          dependencies: s.dependencies,
          stage: s.stage ?? stage.name,
        };
      }),
    });

    // Greedy scheduler: launch tasks as slots free up via Promise.race
    const running = new Map<number, Promise<void>>();

    const tryLaunch = () => {
      while (running.size < this.opts.maxConcurrency && !this.isShuttingDown) {
        const ready = resolver.getReady().filter(idx => !running.has(idx));
        if (ready.length === 0) break;
        const idx = ready[0];

        const startTime = Date.now();
        this.emitDAG({ type: 'subtask-started', index: idx });

        const promise = this.executeSubtask(runId, idx, stage, state, byIndex, resolver)
          .then(oneliner => {
            const elapsed = Date.now() - startTime;
            resolver.markComplete(idx);
            if (!hasDAGDisplay) this.status(oneliner);
            this.emitDAG({ type: 'subtask-completed', index: idx, oneliner, elapsed });
          })
          .catch(err => {
            const elapsed = Date.now() - startTime;
            const errorMsg = err?.message || 'unknown';
            if (!hasDAGDisplay) this.status(`[${stage.name}] [${idx}] Failed: ${errorMsg}`);
            this.emitDAG({ type: 'subtask-failed', index: idx, error: errorMsg, elapsed });
            const cascaded = resolver.markSkipped(idx);
            state.skippedIndices.add(idx);
            for (const cascadedIdx of cascaded) {
              state.skippedIndices.add(cascadedIdx);
              if (!hasDAGDisplay) this.status(`[${stage.name}] [${cascadedIdx}] Skipped (cascade from ${idx})`);
              this.emitDAG({ type: 'subtask-skipped', index: cascadedIdx, cascadeFrom: idx });
            }
          })
          .finally(() => {
            running.delete(idx);
            tryLaunch();
          });

        running.set(idx, promise);
      }
    };

    tryLaunch();

    while (running.size > 0) {
      await Promise.race(running.values());
    }

    this.emitDAG({ type: 'dag-complete' });
  }

  /** Execute a single subtask with per-subtask retry logic (used by greedy DAG scheduler). */
  private async executeSubtask(
    runId: string,
    idx: number,
    stage: StageDefinition,
    state: PipelineState,
    byIndex: Map<number, SubtaskDefinition>,
    resolver: DependencyResolver,
  ): Promise<string> {
    const subtask = byIndex.get(idx)!;
    const effectiveStage = subtask.stage
      ? getStageDefinition(subtask.stage, this.stageRegistry)
      : stage;

    const maxAttempts = (this.opts.maxSubtaskRetries ?? 1) + 1; // default 1 retry = 2 attempts

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        if (shouldRecurse(idx, state.plan!)) {
          return await this.runRecursive(runId, effectiveStage, state, subtask);
        }
        return await this.runOne(runId, effectiveStage, state, subtask);
      } catch (err) {
        const isLastAttempt = attempt >= maxAttempts;
        const isRetryable = this.isRetryableError(err);

        if (isRetryable && !isLastAttempt) {
          this.emitDAG({
            type: 'subtask-retrying',
            index: idx,
            attempt: attempt + 1,
            maxAttempts,
          });
          continue; // retry
        }

        // Not retryable or budget exhausted
        if (attempt > 1) {
          // We did retry at least once
          this.emitDAG({
            type: 'subtask-retry-exhausted',
            index: idx,
            attempts: attempt,
          });
        }
        throw err; // let runDAG's catch handle cascade-skip
      }
    }

    // Should never reach here, but satisfy TypeScript
    throw new Error(`Subtask ${idx} failed after ${maxAttempts} attempts`);
  }

  /** Determine if an error from subtask execution is worth retrying. */
  private isRetryableError(err: unknown): boolean {
    // ClaudeRunError = transient CLI/process failure, always retryable
    if (err instanceof ClaudeRunError) return true;

    // SubtaskError carries retryWorthy metadata from executor output
    if (err instanceof SubtaskError) return err.retryWorthy;

    // Fallback: check by error name for duck-typing compatibility
    if (err instanceof Error && err.name === 'ClaudeRunError') return true;

    return false;
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
    const { onDAGEvent: _, onStageStart: _s, onStageEnd: _e, ...childCb } = this.cb;
    const child = new TaskOrchestrator(childOpts, childCb, this.depth + 1, childLogger, this.stageRegistry);

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

      // Also include cascade-skipped subtasks whose direct dependencies are now complete
      // (they were skipped because a predecessor failed, but after retry the predecessor might succeed)
      const skippedForRetry = Array.from(state.skippedIndices).filter(idx => {
        // Only include if not already in failedIndices
        if (failedIndices.includes(idx)) return false;
        // Check if this subtask exists in the plan
        const subtask = state.plan?.subtasks.find(s => s.index === idx);
        if (!subtask) return false;
        // Include it — the retry mechanism will re-execute and dependencies will be checked
        return true;
      });

      const allRetryIndices = [...failedIndices, ...skippedForRetry];
      this.logStageFailure(stage.name, state, allRetryIndices);

      // No retryStage configured or no retryable indices — fail immediately
      if (!stage.retryStage || allRetryIndices.length === 0 || attempt >= maxRetries) {
        if (attempt >= maxRetries && allRetryIndices.length > 0) {
          this.status(`[${stage.name}] Max retries (${maxRetries}) reached.`);
        }
        return false;
      }

      // Clear retried skipped indices so they can be re-executed
      for (const idx of skippedForRetry) {
        state.skippedIndices.delete(idx);
      }

      // Re-run the configured retry stage for failed + skipped indices
      this.status(`[${stage.name}] Re-executing ${allRetryIndices.length} subtask(s) via ${stage.retryStage} (attempt ${attempt + 1}/${maxRetries})...`);
      const retryStage = getStageDefinition(stage.retryStage, this.stageRegistry);
      const allSubtasks = retryStage.subtaskExtractor?.(state) ?? [];
      const retrySubtasks = allSubtasks.filter(s => allRetryIndices.includes(s.index));

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
    const v = state.verification;
    const failedCount = v ? v.subtaskResults.filter(s => !s.pass).length : 0;
    const skippedCount = state.skippedIndices.size;
    this.status(`[${stageName}] Failed: ${failedCount} subtask(s) failed, ${skippedCount} skipped.`);
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
    // Log skipped subtasks
    if (state.skippedIndices.size > 0) {
      this.status(`[${stageName}] Skipped subtasks (cascade): ${Array.from(state.skippedIndices).join(', ')}`);
    }
  }

  // --- Lifecycle ---

  private printCostSummary(runId: string): void {
    try {
      const m = this.logger.readManifest(runId);
      const dur = m.duration ? ` | Duration: ${formatDuration(m.duration)}` : '';
      const totalIn = m.usage.totalInputTokens + (m.usage.totalCacheReadTokens ?? 0);
      const totalCached = m.usage.totalCacheReadTokens ?? 0;
      const cachedPart = totalCached > 0 ? ` (${formatTokenCount(totalCached)} cached)` : '';
      this.status(
        `\n[Cost] Total: ~$${m.usage.estimatedCost.toFixed(2)} | Tokens: ${formatTokenCount(totalIn)} in${cachedPart} / ${formatTokenCount(m.usage.totalOutputTokens)} out${dur}`
      );

      // Build per-stage usage from pipeline order, aggregating subtask usage
      // for parallel stages that only have perSubtask data
      const stageEntries: { name: string; usage: UsageStats; subtaskCount: number }[] = [];
      for (const name of m.pipeline) {
        if (m.usage.perStage[name]) {
          stageEntries.push({ name, usage: m.usage.perStage[name], subtaskCount: 0 });
        } else {
          // Parallel stage: aggregate from perSubtask
          const subtaskKeys = Object.keys(m.usage.perSubtask);
          if (subtaskKeys.length > 0) {
            const subtaskStats = subtaskKeys.map(k => m.usage.perSubtask[Number(k)]);
            stageEntries.push({ name, usage: aggregateUsage(subtaskStats), subtaskCount: subtaskKeys.length });
          }
        }
      }

      // Find max stage name length for alignment
      const maxNameLen = Math.max(...stageEntries.map(e => e.name.length));

      for (let i = 0; i < stageEntries.length; i++) {
        const { name, usage: s, subtaskCount } = stageEntries[i];
        const prefix = i < stageEntries.length - 1 ? '|--' : '+--';
        const paddedName = `[${name}]`.padEnd(maxNameLen + 2);
        const cost = `$${s.estimatedCost.toFixed(2)}`.padStart(6);
        const stageIn = s.inputTokens + (s.cacheReadTokens ?? 0);
        const stageCached = s.cacheReadTokens ?? 0;
        const stageCachedPart = stageCached > 0 ? ` (${formatTokenCount(stageCached)} cached)` : '';
        let line = `  ${prefix} ${paddedName} ${cost}  (${formatTokenCount(stageIn)} in${stageCachedPart} / ${formatTokenCount(s.outputTokens)} out)`;
        if (subtaskCount > 0) {
          line += `  <- ${subtaskCount} subtask${subtaskCount !== 1 ? 's' : ''}`;
        }
        this.status(line);
      }
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
