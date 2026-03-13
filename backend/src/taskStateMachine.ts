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

  /** Get task counts per status for a project. */
  getTaskCountsByProject(projectId: string): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const task of this.tasks.values()) {
      if (task.projectId === projectId) {
        counts[task.status] = (counts[task.status] || 0) + 1;
      }
    }
    return counts;
  }

  /** Get paginated tasks for a project, sorted by status-appropriate field. */
  getTasksByProjectPaginated(projectId: string, opts: {
    status?: string;
    limit?: number;
    offset?: number;
  }): { tasks: ManagedTask[]; total: number } {
    let tasks = this.getTasksByProject(projectId);
    if (opts.status) {
      tasks = tasks.filter(t => t.status === opts.status);
    }
    const total = tasks.length;

    const status = opts.status;
    if (status === 'completed' || status === 'failed' || status === 'cancelled') {
      tasks.sort((a, b) => {
        const aTime = a.finishedAt ? new Date(a.finishedAt).getTime() : 0;
        const bTime = b.finishedAt ? new Date(b.finishedAt).getTime() : 0;
        return bTime - aTime;
      });
    } else if (status === 'queued') {
      tasks.sort((a, b) => (a.taskNumber ?? Infinity) - (b.taskNumber ?? Infinity));
    } else if (status === 'running') {
      tasks.sort((a, b) => {
        const aTime = new Date(a.startedAt ?? a.createdAt).getTime();
        const bTime = new Date(b.startedAt ?? b.createdAt).getTime();
        return aTime - bTime;
      });
    } else {
      tasks.sort((a, b) => {
        const aTime = new Date(a.createdAt).getTime();
        const bTime = new Date(b.createdAt).getTime();
        return aTime - bTime;
      });
    }

    if (opts.limit !== undefined) {
      const offset = opts.offset ?? 0;
      tasks = tasks.slice(offset, offset + opts.limit);
    }
    return { tasks, total };
  }
}
