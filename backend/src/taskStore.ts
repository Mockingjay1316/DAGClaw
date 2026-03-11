import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { TaskOrchestrator, OrchestratorCallbacks } from '../../core/taskOrchestrator.ts';
import type { CliOptions, DAGEvent, Plan, StageDefinition, PermissionMode } from '../../core/types.ts';
import { RunLogger } from '../../core/runLogger.ts';
import { mergeStages } from '../../core/configLoader.ts';
import { BUILTIN_STAGES } from '../../core/stageDefinitions.ts';
import type { WsServer } from './websocket/wsServer.ts';
import type { TaskScheduler } from './taskScheduler.ts';

export type ManagedTaskStatus = 'todo' | 'queued' | 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'cancelled';

export interface ManagedTask {
  id: string;
  prompt: string;
  workDir: string;
  projectId: string;
  runId: string | null;
  status: ManagedTaskStatus;
  pendingApproval?: { resolve: (approved: boolean) => void; message: string };
  orchestrator: TaskOrchestrator | null;
  error?: string;
  pipeline?: string[];
  permissionMode?: ApiPermissionMode;
  createdAt: string;
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

/** Persistence format for TODO tasks in .dagclaw/tasks.json */
interface TodoTaskFile {
  tasks: Array<{
    id: string;
    prompt: string;
    pipeline?: string[];
    permissionMode?: ApiPermissionMode;
    createdAt: string;
  }>;
}

export class TaskStore {
  private tasks = new Map<string, ManagedTask>();
  private wsServer: WsServer | null = null;
  private scheduler: TaskScheduler | null = null;

  constructor(private customStagesRef?: Record<string, StageDefinition>) {}

  /** Store reference to WsServer for broadcasting. */
  setWsServer(ws: WsServer): void {
    this.wsServer = ws;
  }

  /** Store reference to TaskScheduler. */
  setScheduler(scheduler: TaskScheduler): void {
    this.scheduler = scheduler;
  }

  /** Create a TODO task (not yet executed). Persists to .dagclaw/tasks.json. */
  createTodoTask(opts: {
    projectId: string;
    prompt: string;
    workDir: string;
    pipeline?: string[];
    permissionMode?: ApiPermissionMode;
  }): string {
    const taskId = crypto.randomUUID();
    const now = new Date().toISOString();

    const task: ManagedTask = {
      id: taskId,
      prompt: opts.prompt,
      workDir: opts.workDir,
      projectId: opts.projectId,
      runId: null,
      status: 'todo',
      orchestrator: null,
      pipeline: opts.pipeline,
      permissionMode: opts.permissionMode,
      createdAt: now,
    };

    this.tasks.set(taskId, task);
    this.persistTodoTask(task);

    // Broadcast task creation
    this.wsServer?.broadcastAll({
      type: 'task_created',
      projectId: opts.projectId,
      task: this.toSummary(task),
    });

    return taskId;
  }

  /** Move a TODO task to queued and enqueue in scheduler. */
  executeTask(taskId: string): { error?: string; status?: number } {
    const task = this.tasks.get(taskId);
    if (!task) return { error: 'Task not found', status: 404 };
    if (task.status !== 'todo') return { error: 'Task is not in TODO status', status: 400 };

    const oldStatus = task.status;
    task.status = 'queued';
    this.removeTodoPersistence(task);

    this.broadcastStatusChange(task, oldStatus);

    if (this.scheduler) {
      this.scheduler.enqueue(taskId);
    } else {
      // No scheduler — start immediately
      this.startTask(taskId).catch(err => {
        console.error(`[taskStore] Failed to start task ${taskId}:`, err);
      });
    }

    return {};
  }

  /** Start a queued task — launches the orchestrator. Called by scheduler or directly. */
  async startTask(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    const oldStatus = task.status;
    task.status = 'running';
    this.broadcastStatusChange(task, oldStatus);

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
    };

    const callbacks = this.buildCallbacks(task);

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

    // Run in background
    orchestrator.run().then(
      (result) => {
        task.runId = result.runId;
        const old = task.status;
        task.status = 'completed';
        this.broadcastStatusChange(task, old);
        this.wsServer?.broadcast(taskId, { type: 'task_complete', taskId });
        this.scheduler?.onTaskFinished(taskId);
      },
      (err: unknown) => {
        const old = task.status;
        task.status = 'failed';
        task.error = err instanceof Error ? err.message : String(err);
        console.error(`[taskStore] Task ${taskId} failed:`, task.error);
        this.broadcastStatusChange(task, old);
        this.wsServer?.broadcast(taskId, { type: 'task_error', taskId, error: task.error });
        this.scheduler?.onTaskFinished(taskId);
      },
    );
  }

  /** Backward-compatible: create + immediately queue a task. */
  async createTask(opts: {
    prompt: string;
    workDir: string;
    projectId: string;
    pipeline?: string[];
    autoApprove?: boolean;
    permissionMode?: ApiPermissionMode;
  }): Promise<string> {
    const taskId = this.createTodoTask({
      projectId: opts.projectId,
      prompt: opts.prompt,
      workDir: opts.workDir,
      pipeline: opts.pipeline,
      permissionMode: opts.permissionMode ?? (opts.autoApprove ? 'auto-approve' : undefined),
    });
    this.executeTask(taskId);
    return taskId;
  }

  /** Register a pre-built ManagedTask (used by state restoration). */
  registerTask(task: ManagedTask): void {
    this.tasks.set(task.id, task);
  }

  /** Get a task by id. */
  getTask(id: string): ManagedTask | undefined {
    return this.tasks.get(id);
  }

  /** List all tasks. */
  listTasks(): ManagedTask[] {
    return Array.from(this.tasks.values());
  }

  /** List tasks for a specific project. */
  getTasksByProject(projectId: string): ManagedTask[] {
    return this.listTasks().filter(t => t.projectId === projectId);
  }

  /** List tasks by status. */
  getTasksByStatus(status: ManagedTaskStatus): ManagedTask[] {
    return this.listTasks().filter(t => t.status === status);
  }

  /** Approve a pending task. Returns true if approval was pending. */
  approveTask(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task?.pendingApproval) return false;
    task.pendingApproval.resolve(true);
    task.pendingApproval = undefined;
    const old = task.status;
    task.status = 'running';
    this.broadcastStatusChange(task, old);
    this.wsServer?.broadcast(id, { type: 'approval_resolved', taskId: id, approved: true });
    return true;
  }

  /** Reject a pending task. Returns true if approval was pending. */
  rejectTask(id: string, feedback?: string): boolean {
    const task = this.tasks.get(id);
    if (!task?.pendingApproval) return false;
    task.pendingApproval.resolve(false);
    task.pendingApproval = undefined;
    const old = task.status;
    task.status = 'failed';
    this.broadcastStatusChange(task, old);
    this.wsServer?.broadcast(id, { type: 'approval_resolved', taskId: id, approved: false });
    return true;
  }

  /** Retry a completed/failed task by creating a new task with the same config. */
  async retryTask(id: string): Promise<{ newId: string } | { error: string; status: number }> {
    const original = this.tasks.get(id);
    if (!original) {
      return { error: 'Task not found', status: 404 };
    }
    if (original.status === 'running' || original.status === 'queued' || original.status === 'awaiting_approval') {
      return { error: 'Task is still running', status: 400 };
    }
    const newId = await this.createTask({
      prompt: original.prompt,
      workDir: original.workDir,
      projectId: original.projectId,
      pipeline: original.pipeline,
      permissionMode: original.permissionMode,
    });
    return { newId };
  }

  /** Cancel a running task. Returns true if task existed. */
  cancelTask(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task) return false;

    // If queued, remove from scheduler queue
    if (task.status === 'queued') {
      this.scheduler?.dequeue(id);
    }

    task.orchestrator?.shutdown();
    const old = task.status;
    task.status = 'cancelled';
    this.broadcastStatusChange(task, old);
    this.scheduler?.onTaskFinished(id);
    return true;
  }

  /** Convert task to a summary object for API responses. */
  toSummary(task: ManagedTask): Record<string, unknown> {
    return {
      id: task.id,
      prompt: task.prompt,
      workDir: task.workDir,
      projectId: task.projectId,
      status: task.status,
      runId: task.runId,
      error: task.error,
      createdAt: task.createdAt,
    };
  }

  private broadcastStatusChange(task: ManagedTask, oldStatus: string): void {
    this.wsServer?.broadcastAll({
      type: 'task_status_changed',
      taskId: task.id,
      projectId: task.projectId,
      oldStatus,
      newStatus: task.status,
    });
  }

  private buildCallbacks(task: ManagedTask): OrchestratorCallbacks {
    const taskId = task.id;
    return {
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
              const logger = new RunLogger(task.workDir);
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
        const runId = task.orchestrator?.currentRunId;
        if (runId) {
          try {
            const logger = new RunLogger(task.workDir);
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
          const old = task.status;
          task.status = 'awaiting_approval';
          this.broadcastStatusChange(task, old);
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
  }

  /** Persist a TODO task to .dagclaw/tasks.json in its workDir. */
  private persistTodoTask(task: ManagedTask): void {
    try {
      const filePath = path.join(task.workDir, '.dagclaw', 'tasks.json');
      const dir = path.dirname(filePath);
      fs.mkdirSync(dir, { recursive: true });

      let data: TodoTaskFile = { tasks: [] };
      if (fs.existsSync(filePath)) {
        try {
          data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        } catch { /* start fresh */ }
      }

      data.tasks.push({
        id: task.id,
        prompt: task.prompt,
        pipeline: task.pipeline,
        permissionMode: task.permissionMode,
        createdAt: task.createdAt,
      });

      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      console.error(`[taskStore] Failed to persist TODO task:`, err);
    }
  }

  /** Remove a task from .dagclaw/tasks.json when it moves out of TODO. */
  private removeTodoPersistence(task: ManagedTask): void {
    try {
      const filePath = path.join(task.workDir, '.dagclaw', 'tasks.json');
      if (!fs.existsSync(filePath)) return;

      const data: TodoTaskFile = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      data.tasks = data.tasks.filter(t => t.id !== task.id);
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      console.error(`[taskStore] Failed to remove TODO persistence:`, err);
    }
  }
}
