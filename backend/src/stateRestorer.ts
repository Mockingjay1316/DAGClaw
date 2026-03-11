import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Project } from './projectStore.ts';
import type { TaskStore, ManagedTask, ApiPermissionMode } from './taskStore.ts';

interface TodoTaskEntry {
  id: string;
  prompt: string;
  pipeline?: string[];
  permissionMode?: ApiPermissionMode;
  createdAt: string;
  taskNumber?: number;
}

interface RestorationResult {
  projectId: string;
  projectName: string;
  todoCount: number;
  completedCount: number;
  failedCount: number;
  interruptedCount: number;
}

/**
 * Restores task state from disk on server startup.
 * For each project: reads TODO tasks from tasks.json and scans run manifests.
 */
export function restoreState(
  projects: Project[],
  taskStore: TaskStore,
): RestorationResult[] {
  const results: RestorationResult[] = [];

  for (const project of projects) {
    const result: RestorationResult = {
      projectId: project.id,
      projectName: project.name,
      todoCount: 0,
      completedCount: 0,
      failedCount: 0,
      interruptedCount: 0,
    };

    // 1. Restore TODO tasks from tasks.json
    const todosRestored = restoreTodoTasks(project, taskStore);
    result.todoCount = todosRestored;

    // 2. Scan run manifests and create in-memory tasks
    const runCounts = restoreRunTasks(project, taskStore);
    result.completedCount = runCounts.completed;
    result.failedCount = runCounts.failed;
    result.interruptedCount = runCounts.interrupted;

    results.push(result);
  }

  return results;
}

function restoreTodoTasks(project: Project, taskStore: TaskStore): number {
  const tasksFile = path.join(project.path, '.dagclaw', 'tasks.json');
  if (!fs.existsSync(tasksFile)) return 0;

  try {
    const raw = fs.readFileSync(tasksFile, 'utf-8');
    const data = JSON.parse(raw) as { tasks: TodoTaskEntry[] };
    let count = 0;

    for (const entry of data.tasks) {
      const task: ManagedTask = {
        id: entry.id,
        prompt: entry.prompt,
        workDir: project.path,
        projectId: project.id,
        runId: null,
        status: 'todo',
        orchestrator: null,
        pipeline: entry.pipeline,
        permissionMode: entry.permissionMode,
        createdAt: entry.createdAt,
        taskNumber: entry.taskNumber ?? 0,
      };
      taskStore.registerTask(task);
      count++;
    }

    return count;
  } catch (err) {
    console.error(`[stateRestorer] Failed to read tasks.json for ${project.name}:`, err);
    return 0;
  }
}

function restoreRunTasks(
  project: Project,
  taskStore: TaskStore,
): { completed: number; failed: number; interrupted: number } {
  const runsDir = path.join(project.path, '.dagclaw', 'runs');
  if (!fs.existsSync(runsDir)) return { completed: 0, failed: 0, interrupted: 0 };

  const counts = { completed: 0, failed: 0, interrupted: 0 };

  try {
    const runDirs = fs.readdirSync(runsDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)
      .sort(); // Chronological: older runs get lower task numbers

    for (const runId of runDirs) {
      const manifestPath = path.join(runsDir, runId, 'manifest.json');
      if (!fs.existsSync(manifestPath)) continue;

      try {
        const raw = fs.readFileSync(manifestPath, 'utf-8');
        const manifest = JSON.parse(raw);

        let status: ManagedTask['status'];
        let error: string | undefined;

        if (manifest.status === 'completed') {
          status = 'completed';
          counts.completed++;
        } else if (manifest.status === 'failed' || manifest.status === 'cancelled') {
          status = manifest.status === 'cancelled' ? 'cancelled' : 'failed';
          counts.failed++;
        } else if (manifest.status === 'running') {
          // Was running when server died — mark as failed
          status = 'failed';
          error = 'Interrupted by server restart';
          counts.interrupted++;
        } else {
          status = 'failed';
          counts.failed++;
        }

        const task: ManagedTask = {
          id: crypto.randomUUID(),
          prompt: manifest.prompt ?? `Run ${runId}`,
          workDir: project.path,
          projectId: project.id,
          runId: runId,
          status,
          orchestrator: null,
          error,
          pipeline: manifest.pipeline,
          createdAt: manifest.startedAt ?? new Date().toISOString(),
          taskNumber: 0,
        };

        taskStore.registerTask(task);
      } catch {
        // Skip corrupt manifests
      }
    }
  } catch (err) {
    console.error(`[stateRestorer] Failed to scan runs for ${project.name}:`, err);
  }

  return counts;
}
