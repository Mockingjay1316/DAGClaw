import type { TaskOrchestrator } from '../../core/taskOrchestrator.ts';

export type ManagedTaskStatus = 'todo' | 'queued' | 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'cancelled';

/** Frontend permission mode values accepted by the API. */
export type ApiPermissionMode = 'interactive' | 'auto-approve' | 'yolo';

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
  taskNumber: number;
  startedAt?: string;
  finishedAt?: string;
}

/** Convert a ManagedTask to an API-safe summary object. */
export function toSummary(task: ManagedTask): Record<string, unknown> {
  return {
    id: task.id,
    prompt: task.prompt,
    workDir: task.workDir,
    projectId: task.projectId,
    status: task.status,
    runId: task.runId,
    error: task.error,
    createdAt: task.createdAt,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
    taskNumber: task.taskNumber,
  };
}

/**
 * In-memory task registry with query methods and task number management.
 */
export class TaskStateMachine {
  private tasks = new Map<string, ManagedTask>();
  private nextTaskNumber = 1;

  /** Get next task number and increment. */
  allocateTaskNumber(): number {
    return this.nextTaskNumber++;
  }

  /** Update next task number if the given number is >= current. */
  updateNextTaskNumber(num: number): void {
    if (num >= this.nextTaskNumber) {
      this.nextTaskNumber = num + 1;
    }
  }

  /** Set a task in the registry. */
  set(id: string, task: ManagedTask): void {
    this.tasks.set(id, task);
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
}
