import { TaskOrchestrator, OrchestratorCallbacks } from '../../core/taskOrchestrator.ts';
import type { CliOptions, DAGEvent, Plan, StageDefinition, PermissionMode } from '../../core/types.ts';
import { RunLogger } from '../../core/runLogger.ts';
import type { ManagedTask, ApiPermissionMode } from './taskStateMachine.ts';
import type { TaskStateMachine } from './taskStateMachine.ts';
import type { BroadcastManager } from './broadcastManager.ts';
import type { TaskScheduler } from './taskScheduler.ts';

/** Map API permissionMode (or legacy autoApprove) to CliOptions-compatible values. */
export function mapPermissionMode(
  mode?: ApiPermissionMode,
  legacyAutoApprove?: boolean,
): { autoApprove: boolean; dangerouslySkipPermissions: boolean; permissionMode: PermissionMode } {
  if (mode === 'interactive') {
    return { autoApprove: false, dangerouslySkipPermissions: false, permissionMode: 'interactive' };
  }
  if (mode === 'auto-approve') {
    return { autoApprove: true, dangerouslySkipPermissions: false, permissionMode: 'auto' };
  }
  if (mode === 'yolo') {
    return { autoApprove: true, dangerouslySkipPermissions: true, permissionMode: 'auto' };
  }
  // Fallback: no permissionMode provided — use legacy autoApprove boolean
  const auto = legacyAutoApprove ?? false;
  return { autoApprove: auto, dangerouslySkipPermissions: false, permissionMode: 'auto' };
}

/** Map DAGEvent.type to WebSocket message type. */
function mapDAGEventType(event: DAGEvent): string {
  switch (event.type) {
    case 'dag-start': return 'tree_snapshot';
    case 'subtask-started': return 'subtask_start';
    case 'subtask-completed': return 'subtask_complete';
    case 'subtask-failed': return 'subtask_complete';
    case 'subtask-skipped': return 'subtask_complete';
    case 'dag-complete': return 'stage_complete';
    default: return 'unknown';
  }
}

/**
 * Manages orchestrator lifecycle: creating, running, and handling completion of TaskOrchestrators.
 */
export class OrchestratorManager {
  constructor(
    private stateMachine: TaskStateMachine,
    private broadcaster: BroadcastManager,
    private scheduler: TaskScheduler | null,
    private getStageRegistry: (projectPath: string) => Record<string, StageDefinition> | undefined,
  ) {}

  setScheduler(scheduler: TaskScheduler): void {
    this.scheduler = scheduler;
  }

  /** Start a queued task — launches the orchestrator. Called by scheduler or directly. */
  async startTask(taskId: string): Promise<void> {
    const task = this.stateMachine.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    const oldStatus = task.status;
    task.status = 'running';
    if (!task.startedAt) {
      task.startedAt = new Date().toISOString();
    }
    this.broadcaster.broadcastStatusChange(task, oldStatus);

    const mapped = mapPermissionMode(task.permissionMode);

    const cliOpts: CliOptions = {
      prompt: task.prompt,
      workDir: task.workDir,
      pipeline: task.pipeline ?? ['Plan', 'Execute', 'Verify'],
      backend: { type: 'cli' },
      permissionMode: mapped.permissionMode,
      autoApprove: mapped.autoApprove,
      maxRetries: 1,
      maxConcurrency: 4,
      maxDepth: 3,
      timeoutSeconds: 300,
      noSummary: true,
      noMemory: false,
      dagStages: ['Execute'],
      taskNumber: task.taskNumber,
      model: task.model,
    };

    const callbacks = this.buildCallbacks(task);

    const stageRegistry = this.getStageRegistry(task.workDir);

    const orchestrator = new TaskOrchestrator(
      cliOpts,
      callbacks,
      0,
      undefined,
      stageRegistry,
    );
    task.orchestrator = orchestrator;

    // Run in background
    orchestrator.run().then(
      (result) => {
        task.runId = result.runId;
        const old = task.status;
        if (result.success) {
          task.status = 'completed';
          task.finishedAt = new Date().toISOString();
          this.broadcaster.broadcastStatusChange(task, old);
          this.broadcaster.broadcast(taskId, { type: 'task_complete', taskId });
        } else {
          // Plan was rejected or run failed without throwing.
          // rejectTask() may have already set a terminal status — respect it.
          if (old !== 'failed' && old !== 'cancelled') {
            task.status = 'failed';
          }
          task.finishedAt = task.finishedAt ?? new Date().toISOString();
          if (task.status !== old) {
            this.broadcaster.broadcastStatusChange(task, old);
          }
          this.broadcaster.broadcast(taskId, {
            type: 'task_error',
            taskId,
            error: 'Run did not complete successfully',
          });
        }
        this.scheduler?.onTaskFinished(taskId);
      },
      (err: unknown) => {
        const old = task.status;
        task.status = 'failed';
        task.finishedAt = new Date().toISOString();
        task.error = err instanceof Error ? err.message : String(err);
        console.error(`[orchestratorManager] Task ${taskId} failed:`, task.error);
        this.broadcaster.broadcastStatusChange(task, old);
        this.broadcaster.broadcast(taskId, { type: 'task_error', taskId, error: task.error });
        this.scheduler?.onTaskFinished(taskId);
      },
    );
  }

  private buildCallbacks(task: ManagedTask): OrchestratorCallbacks {
    const taskId = task.id;
    return {
      onStatus: (msg: string) => {
        this.broadcaster.broadcast(taskId, { type: 'node_status', taskId, message: msg });
      },
      onDAGEvent: (event: DAGEvent) => {
        const { type: _eventType, ...eventData } = event;
        this.broadcaster.broadcast(taskId, { type: mapDAGEventType(event), taskId, ...eventData });
        // Broadcast usage update after each subtask completes
        if (event.type === 'subtask-completed' || event.type === 'subtask-failed') {
          this.broadcastUsage(task);
        }
      },
      onStageStart: (label: string, stageName?: string) => {
        this.broadcaster.broadcast(taskId, { type: 'stage_start', taskId, label, stageName: stageName ?? label });
      },
      onStageEnd: () => {
        this.broadcaster.broadcast(taskId, { type: 'stage_complete', taskId });
        this.broadcastUsage(task);
      },
      onApprovalRequest: (message: string) => {
        return new Promise<boolean>((resolve) => {
          task.pendingApproval = { resolve, message };
          const old = task.status;
          task.status = 'awaiting_approval';
          this.broadcaster.broadcastStatusChange(task, old);
          this.broadcaster.broadcast(taskId, { type: 'approval_required', taskId, message });
        });
      },
      onWarning: (msg: string) => {
        this.broadcaster.broadcast(taskId, { type: 'node_status', taskId, message: '[warn] ' + msg });
      },
      onPlanReady: (plan: Plan) => {
        this.broadcaster.broadcast(taskId, { type: 'plan_ready', taskId, plan });
      },
    };
  }

  /** Broadcast usage update for a task from its RunLogger manifest. */
  private broadcastUsage(task: ManagedTask): void {
    const runId = task.orchestrator?.currentRunId;
    if (runId) {
      try {
        const logger = new RunLogger(task.workDir);
        const manifest = logger.readManifest(runId);
        this.broadcaster.broadcast(task.id, {
          type: 'usage_update',
          taskId: task.id,
          usage: manifest.usage,
        });
      } catch {
        // Ignore if manifest not readable yet
      }
    }
  }
}
