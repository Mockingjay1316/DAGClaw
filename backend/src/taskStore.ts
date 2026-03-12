import crypto from 'node:crypto';
import type { StageDefinition } from '../../core/types.ts';
import { mergeStages, loadCustomStages } from '../../core/configLoader.ts';
import { BUILTIN_STAGES } from '../../core/stageDefinitions.ts';
import type { WsServer } from './websocket/wsServer.ts';
import type { TaskScheduler } from './taskScheduler.ts';
import { TaskStateMachine, toSummary } from './taskStateMachine.ts';
import type { ManagedTask, ManagedTaskStatus, ApiPermissionMode } from './taskStateMachine.ts';
import { persistTodoTask, removeTodoPersistence } from './taskPersistence.ts';
import { BroadcastManager } from './broadcastManager.ts';
import { OrchestratorManager, mapPermissionMode } from './orchestratorManager.ts';

export { ManagedTask, ManagedTaskStatus, ApiPermissionMode, mapPermissionMode };

/**
 * Thin facade that wires together TaskStateMachine, BroadcastManager,
 * OrchestratorManager, and persistence. Public API is unchanged.
 */
export class TaskStore {
  private stateMachine = new TaskStateMachine();
  private broadcaster = new BroadcastManager();
  private orchestratorManager: OrchestratorManager;
  private scheduler: TaskScheduler | null = null;
  private projectStages = new Map<string, Record<string, StageDefinition>>();

  constructor() {
    this.orchestratorManager = new OrchestratorManager(
      this.stateMachine,
      this.broadcaster,
      null,
      (path) => this.getStageRegistry(path),
    );
  }

  /** Store reference to WsServer for broadcasting. */
  setWsServer(ws: WsServer): void {
    this.broadcaster.setWsServer(ws);
  }

  /** Store reference to TaskScheduler. */
  setScheduler(scheduler: TaskScheduler): void {
    this.scheduler = scheduler;
    this.orchestratorManager.setScheduler(scheduler);
  }

  /** Load custom stages from a project's dagclaw.config.ts/.json and cache them. */
  async loadProjectStages(projectPath: string): Promise<void> {
    const custom = await loadCustomStages(projectPath);
    if (Object.keys(custom).length > 0) {
      this.projectStages.set(projectPath, custom);
      console.log(`[taskStore] Loaded ${Object.keys(custom).length} custom stage(s) for ${projectPath}`);
    }
  }

  /** Get the merged stage registry for a project (builtins + project custom stages). */
  getStageRegistry(projectPath: string): Record<string, StageDefinition> | undefined {
    const custom = this.projectStages.get(projectPath);
    return custom ? mergeStages(BUILTIN_STAGES, custom) : undefined;
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
      taskNumber: this.stateMachine.allocateTaskNumber(),
    };

    this.stateMachine.set(taskId, task);
    persistTodoTask(task);

    // Broadcast task creation
    this.broadcaster.broadcastAll({
      type: 'task_created',
      projectId: opts.projectId,
      task: toSummary(task),
    });

    return taskId;
  }

  /** Move a TODO task to queued and enqueue in scheduler. */
  executeTask(taskId: string): { error?: string; status?: number } {
    const task = this.stateMachine.getTask(taskId);
    if (!task) return { error: 'Task not found', status: 404 };
    if (task.status !== 'todo') return { error: 'Task is not in TODO status', status: 400 };

    const oldStatus = task.status;
    task.status = 'queued';
    removeTodoPersistence(task);

    this.broadcaster.broadcastStatusChange(task, oldStatus);

    if (this.scheduler) {
      this.scheduler.enqueue(taskId);
    } else {
      this.startTask(taskId).catch(err => {
        console.error(`[taskStore] Failed to start task ${taskId}:`, err);
      });
    }

    return {};
  }

  /** Start a queued task — delegates to OrchestratorManager. */
  async startTask(taskId: string): Promise<void> {
    return this.orchestratorManager.startTask(taskId);
  }

  /** Create a task and immediately queue it for execution. Skips TODO state entirely. */
  async createTask(opts: {
    prompt: string;
    workDir: string;
    projectId: string;
    pipeline?: string[];
    autoApprove?: boolean;
    permissionMode?: ApiPermissionMode;
  }): Promise<string> {
    const taskId = crypto.randomUUID();
    const now = new Date().toISOString();

    const task: ManagedTask = {
      id: taskId,
      prompt: opts.prompt,
      workDir: opts.workDir,
      projectId: opts.projectId,
      runId: null,
      status: 'queued',
      orchestrator: null,
      pipeline: opts.pipeline,
      permissionMode: opts.permissionMode ?? (opts.autoApprove ? 'auto-approve' : undefined),
      createdAt: now,
      taskNumber: this.stateMachine.allocateTaskNumber(),
    };

    this.stateMachine.set(taskId, task);

    // Broadcast as created with queued status — single message, no transient TODO
    this.broadcaster.broadcastAll({
      type: 'task_created',
      projectId: opts.projectId,
      task: toSummary(task),
    });

    if (this.scheduler) {
      this.scheduler.enqueue(taskId);
    } else {
      this.startTask(taskId).catch(err => {
        console.error(`[taskStore] Failed to start task ${taskId}:`, err);
      });
    }

    return taskId;
  }

  /** Register a pre-built ManagedTask (used by state restoration). */
  registerTask(task: ManagedTask): void {
    if (task.taskNumber === 0) {
      task.taskNumber = this.stateMachine.allocateTaskNumber();
    }
    this.stateMachine.set(task.id, task);
    this.stateMachine.updateNextTaskNumber(task.taskNumber);
  }

  /** Get a task by id. */
  getTask(id: string): ManagedTask | undefined {
    return this.stateMachine.getTask(id);
  }

  /** List all tasks. */
  listTasks(): ManagedTask[] {
    return this.stateMachine.listTasks();
  }

  /** List tasks for a specific project. */
  getTasksByProject(projectId: string): ManagedTask[] {
    return this.stateMachine.getTasksByProject(projectId);
  }

  /** List tasks by status. */
  getTasksByStatus(status: ManagedTaskStatus): ManagedTask[] {
    return this.stateMachine.getTasksByStatus(status);
  }

  /** Approve a pending task. Returns true if approval was pending. */
  approveTask(id: string): boolean {
    const task = this.stateMachine.getTask(id);
    if (!task?.pendingApproval) return false;
    task.pendingApproval.resolve(true);
    task.pendingApproval = undefined;
    const old = task.status;
    task.status = 'running';
    this.broadcaster.broadcastStatusChange(task, old);
    this.broadcaster.broadcast(id, { type: 'approval_resolved', taskId: id, approved: true });
    return true;
  }

  /** Reject a pending task. Returns true if approval was pending. */
  rejectTask(id: string, feedback?: string): boolean {
    const task = this.stateMachine.getTask(id);
    if (!task?.pendingApproval) return false;
    task.pendingApproval.resolve(false);
    task.pendingApproval = undefined;
    const old = task.status;
    task.status = 'cancelled';
    task.finishedAt = new Date().toISOString();
    this.broadcaster.broadcastStatusChange(task, old);
    this.broadcaster.broadcast(id, { type: 'approval_resolved', taskId: id, approved: false });
    return true;
  }

  /** Retry a completed/failed task by creating a new task with the same config. */
  async retryTask(id: string): Promise<{ newId: string } | { error: string; status: number }> {
    const original = this.stateMachine.getTask(id);
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
    const task = this.stateMachine.getTask(id);
    if (!task) return false;

    // If queued, remove from scheduler queue
    if (task.status === 'queued') {
      this.scheduler?.dequeue(id);
    }

    task.orchestrator?.shutdown();
    const old = task.status;
    task.status = 'cancelled';
    task.finishedAt = new Date().toISOString();
    this.broadcaster.broadcastStatusChange(task, old);
    this.scheduler?.onTaskFinished(id);
    return true;
  }

  /** Convert task to a summary object for API responses. */
  toSummary(task: ManagedTask): Record<string, unknown> {
    return toSummary(task);
  }
}
