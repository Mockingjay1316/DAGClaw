import crypto from 'node:crypto';
import { TaskOrchestrator, OrchestratorCallbacks } from '../../core/taskOrchestrator.ts';
import type { CliOptions, DAGEvent, Plan, StageDefinition, PermissionMode } from '../../core/types.ts';
import { RunLogger } from '../../core/runLogger.ts';
import { mergeStages } from '../../core/configLoader.ts';
import { BUILTIN_STAGES } from '../../core/stageDefinitions.ts';
import type { WsServer } from './websocket/wsServer.ts';

export interface ManagedTask {
  id: string;
  prompt: string;
  workDir: string;
  runId: string | null;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  pendingApproval?: { resolve: (approved: boolean) => void; message: string };
  orchestrator: TaskOrchestrator | null;
  error?: string;
  pipeline?: string[];
  permissionMode?: ApiPermissionMode;
}

/** Frontend permission mode values accepted by the API. */
export type ApiPermissionMode = 'interactive' | 'auto-approve' | 'yolo';

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

export class TaskStore {
  private tasks = new Map<string, ManagedTask>();
  private wsServer: WsServer | null = null;

  constructor(private customStagesRef?: Record<string, StageDefinition>) {}

  /** Store reference to WsServer for broadcasting. */
  setWsServer(ws: WsServer): void {
    this.wsServer = ws;
  }

  /** Create and start a new task, returning the task id. */
  async createTask(opts: {
    prompt: string;
    workDir: string;
    pipeline?: string[];
    autoApprove?: boolean;
    permissionMode?: ApiPermissionMode;
  }): Promise<string> {
    const MAX_CONCURRENT_TASKS = parseInt(process.env.CLAW_MAX_TASKS || '5', 10);
    const running = [...this.tasks.values()].filter(t => t.status === 'running').length;
    if (running >= MAX_CONCURRENT_TASKS) {
      throw new Error('Too many running tasks');
    }

    const taskId = crypto.randomUUID();

    // Map API permission mode to CLI options
    const mapped = mapPermissionMode(opts.permissionMode, opts.autoApprove);
    // TODO: dangerouslySkipPermissions needs plumbing through CliOptions in a future change.
    // Currently hardcoded to true in taskOrchestrator.ts runOne().
    // mapped.dangerouslySkipPermissions is derived but not yet passed to CliOptions.

    const cliOpts: CliOptions = {
      prompt: opts.prompt,
      workDir: opts.workDir,
      pipeline: opts.pipeline ?? ['Plan', 'Execute', 'Verify'],
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
    };

    const task: ManagedTask = {
      id: taskId,
      prompt: opts.prompt,
      workDir: opts.workDir,
      runId: null,
      status: 'running',
      orchestrator: null,
      pipeline: opts.pipeline,
      permissionMode: opts.permissionMode,
    };

    this.tasks.set(taskId, task);

    const callbacks: OrchestratorCallbacks = {
      onStatus: (msg: string) => {
        this.wsServer?.broadcast(taskId, { type: 'node_status', taskId, message: msg });
      },
      onDAGEvent: (event: DAGEvent) => {
        const { type: _eventType, ...eventData } = event;
        this.wsServer?.broadcast(taskId, { type: mapDAGEventType(event), taskId, ...eventData });
        // Broadcast usage update after each subtask completes
        if (event.type === 'subtask-completed' || event.type === 'subtask-failed') {
          const runId = task.orchestrator?.currentRunId;
          if (runId) {
            try {
              const logger = new RunLogger(opts.workDir);
              const manifest = logger.readManifest(runId);
              this.wsServer?.broadcast(taskId, {
                type: 'usage_update',
                taskId,
                usage: manifest.usage,
              });
            } catch {
              // Ignore if manifest not readable yet
            }
          }
        }
      },
      onStageStart: (label: string, stageName?: string) => {
        this.wsServer?.broadcast(taskId, { type: 'stage_start', taskId, label, stageName: stageName ?? label });
      },
      onStageEnd: () => {
        this.wsServer?.broadcast(taskId, { type: 'stage_complete', taskId });
        // Broadcast usage update after stage completes
        const runId = task.orchestrator?.currentRunId;
        if (runId) {
          try {
            const logger = new RunLogger(opts.workDir);
            const manifest = logger.readManifest(runId);
            this.wsServer?.broadcast(taskId, {
              type: 'usage_update',
              taskId,
              usage: manifest.usage,
            });
          } catch {
            // Ignore if manifest not readable yet
          }
        }
      },
      onApprovalRequest: (message: string) => {
        return new Promise<boolean>((resolve) => {
          task.pendingApproval = { resolve, message };
          task.status = 'pending';
          this.wsServer?.broadcast(taskId, { type: 'approval_required', taskId, message });
        });
      },
      onWarning: (msg: string) => {
        this.wsServer?.broadcast(taskId, { type: 'node_status', taskId, message: '[warn] ' + msg });
      },
      onPlanReady: (plan: Plan) => {
        this.wsServer?.broadcast(taskId, { type: 'plan_ready', taskId, plan });
      },
    };

    const stageRegistry = this.customStagesRef
      ? mergeStages(BUILTIN_STAGES, this.customStagesRef)
      : undefined;

    const orchestrator = new TaskOrchestrator(
      cliOpts,
      callbacks,
      0,
      undefined,
      stageRegistry,
    );
    task.orchestrator = orchestrator;

    // Start in background (don't await)
    orchestrator.run().then(
      (result) => {
        task.runId = result.runId;
        task.status = 'completed';
        this.wsServer?.broadcast(taskId, { type: 'task_complete', taskId });
      },
      (err: unknown) => {
        task.status = 'failed';
        task.error = err instanceof Error ? err.message : String(err);
        console.error(`[taskStore] Task ${taskId} failed:`, task.error);
        this.wsServer?.broadcast(taskId, { type: 'task_error', taskId, error: task.error });
      },
    );

    return taskId;
  }

  /** Get a task by id. */
  getTask(id: string): ManagedTask | undefined {
    return this.tasks.get(id);
  }

  /** List all tasks. */
  listTasks(): ManagedTask[] {
    return Array.from(this.tasks.values());
  }

  /** Approve a pending task. Returns true if approval was pending. */
  approveTask(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task?.pendingApproval) return false;
    task.pendingApproval.resolve(true);
    task.pendingApproval = undefined;
    task.status = 'running';
    this.wsServer?.broadcast(id, { type: 'approval_resolved', taskId: id, approved: true });
    return true;
  }

  /** Reject a pending task. Returns true if approval was pending. */
  rejectTask(id: string, feedback?: string): boolean {
    const task = this.tasks.get(id);
    if (!task?.pendingApproval) return false;
    task.pendingApproval.resolve(false);
    task.pendingApproval = undefined;
    task.status = 'failed';
    this.wsServer?.broadcast(id, { type: 'approval_resolved', taskId: id, approved: false });
    return true;
  }

  /** Retry a completed/failed task by creating a new task with the same config. */
  async retryTask(id: string): Promise<{ newId: string } | { error: string; status: number }> {
    const original = this.tasks.get(id);
    if (!original) {
      return { error: 'Task not found', status: 404 };
    }
    if (original.status === 'running' || original.status === 'pending') {
      return { error: 'Task is still running', status: 400 };
    }
    const newId = await this.createTask({
      prompt: original.prompt,
      workDir: original.workDir,
      pipeline: original.pipeline,
      permissionMode: original.permissionMode,
    });
    return { newId };
  }

  /** Cancel a running task. Returns true if task existed. */
  cancelTask(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task) return false;
    task.orchestrator?.shutdown();
    task.status = 'cancelled';
    return true;
  }
}
