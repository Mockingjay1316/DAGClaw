import fs from 'node:fs';
import path from 'node:path';
import type { ManagedTask, ApiPermissionMode } from './taskStateMachine.ts';

/** Persistence format for TODO tasks in .dagclaw/tasks.json */
export interface TodoTaskFile {
  tasks: Array<{
    id: string;
    prompt: string;
    pipeline?: string[];
    permissionMode?: ApiPermissionMode;
    createdAt: string;
    taskNumber: number;
  }>;
}

/** Persist a TODO task to .dagclaw/tasks.json in its workDir. */
export function persistTodoTask(task: ManagedTask): void {
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
      taskNumber: task.taskNumber,
    });

    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.error(`[taskPersistence] Failed to persist TODO task:`, err);
  }
}

/** Remove a task from .dagclaw/tasks.json when it moves out of TODO. */
export function removeTodoPersistence(task: ManagedTask): void {
  try {
    const filePath = path.join(task.workDir, '.dagclaw', 'tasks.json');
    if (!fs.existsSync(filePath)) return;

    const data: TodoTaskFile = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    data.tasks = data.tasks.filter(t => t.id !== task.id);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.error(`[taskPersistence] Failed to remove TODO persistence:`, err);
  }
}
