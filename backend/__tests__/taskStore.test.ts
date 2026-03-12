import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TaskStore, ManagedTask, mapPermissionMode } from '../src/taskStore.ts';

const PROJECT_ID = 'test-project-id';

describe('TaskStore', () => {
  it('createTask returns a task id string', async () => {
    const store = new TaskStore();
    const id = await store.createTask({ prompt: 'test task', workDir: '/tmp', projectId: PROJECT_ID });
    assert.equal(typeof id, 'string');
    assert.ok(id.length > 0);
  });

  it('getTask returns the created task', async () => {
    const store = new TaskStore();
    const id = await store.createTask({ prompt: 'hello', workDir: '/tmp', projectId: PROJECT_ID });
    const task = store.getTask(id);
    assert.ok(task);
    assert.equal(task.id, id);
    assert.equal(task.prompt, 'hello');
    assert.equal(task.workDir, '/tmp');
    assert.equal(task.projectId, PROJECT_ID);
  });

  it('getTask returns undefined for non-existent id', () => {
    const store = new TaskStore();
    assert.equal(store.getTask('non-existent'), undefined);
  });

  it('listTasks returns all tasks', async () => {
    const store = new TaskStore();
    const id1 = await store.createTask({ prompt: 'task 1', workDir: '/tmp', projectId: PROJECT_ID });
    const id2 = await store.createTask({ prompt: 'task 2', workDir: '/tmp', projectId: PROJECT_ID });
    const tasks = store.listTasks();
    assert.equal(tasks.length, 2);
    const ids = tasks.map(t => t.id);
    assert.ok(ids.includes(id1));
    assert.ok(ids.includes(id2));
  });

  it('approveTask resolves pending approval', () => {
    const store = new TaskStore();
    let resolved: boolean | undefined;
    const task: ManagedTask = {
      id: 'test-approve',
      prompt: 'approve me',
      workDir: '/tmp',
      projectId: PROJECT_ID,
      runId: null,
      status: 'awaiting_approval',
      orchestrator: null,
      createdAt: new Date().toISOString(),
      taskNumber: 1,
      pendingApproval: {
        resolve: (val: boolean) => { resolved = val; },
        message: 'Please approve',
      },
    };
    (store as any).tasks.set('test-approve', task);

    const result = store.approveTask('test-approve');
    assert.equal(result, true);
    assert.equal(resolved, true);
    assert.equal(task.status, 'running');
    assert.equal(task.pendingApproval, undefined);
  });

  it('rejectTask resolves pending approval with false', () => {
    const store = new TaskStore();
    let resolved: boolean | undefined;
    const task: ManagedTask = {
      id: 'test-reject',
      prompt: 'reject me',
      workDir: '/tmp',
      projectId: PROJECT_ID,
      runId: null,
      status: 'awaiting_approval',
      orchestrator: null,
      createdAt: new Date().toISOString(),
      taskNumber: 1,
      pendingApproval: {
        resolve: (val: boolean) => { resolved = val; },
        message: 'Please approve',
      },
    };
    (store as any).tasks.set('test-reject', task);

    const result = store.rejectTask('test-reject', 'not good enough');
    assert.equal(result, true);
    assert.equal(resolved, false);
    assert.equal(task.status, 'failed');
    assert.equal(task.pendingApproval, undefined);
  });

  it('cancelTask sets status to cancelled', () => {
    const store = new TaskStore();
    let shutdownCalled = false;
    const task: ManagedTask = {
      id: 'test-cancel',
      prompt: 'cancel me',
      workDir: '/tmp',
      projectId: PROJECT_ID,
      runId: null,
      status: 'running',
      orchestrator: { shutdown: () => { shutdownCalled = true; } } as any,
      createdAt: new Date().toISOString(),
      taskNumber: 1,
    };
    (store as any).tasks.set('test-cancel', task);

    const result = store.cancelTask('test-cancel');
    assert.equal(result, true);
    assert.equal(task.status, 'cancelled');
    assert.equal(shutdownCalled, true);
  });

  it('approveTask on non-existent task returns false', () => {
    const store = new TaskStore();
    assert.equal(store.approveTask('does-not-exist'), false);
  });

  it('rejectTask on non-existent task returns false', () => {
    const store = new TaskStore();
    assert.equal(store.rejectTask('does-not-exist'), false);
  });

  it('cancelTask on non-existent task returns false', () => {
    const store = new TaskStore();
    assert.equal(store.cancelTask('does-not-exist'), false);
  });

  it('getStageRegistry returns undefined when no custom stages loaded', () => {
    const store = new TaskStore();
    assert.equal(store.getStageRegistry('/nonexistent'), undefined);
  });

  it('approveTask on task without pending approval returns false', () => {
    const store = new TaskStore();
    const task: ManagedTask = {
      id: 'no-approval',
      prompt: 'test',
      workDir: '/tmp',
      projectId: PROJECT_ID,
      runId: null,
      status: 'running',
      orchestrator: null,
      createdAt: new Date().toISOString(),
      taskNumber: 1,
    };
    (store as any).tasks.set('no-approval', task);
    assert.equal(store.approveTask('no-approval'), false);
  });

  it('createTodoTask creates a task with todo status', () => {
    const store = new TaskStore();
    const id = store.createTodoTask({
      projectId: PROJECT_ID,
      prompt: 'todo task',
      workDir: '/tmp',
    });
    const task = store.getTask(id);
    assert.ok(task);
    assert.equal(task.status, 'todo');
    assert.equal(task.projectId, PROJECT_ID);
    assert.equal(task.prompt, 'todo task');
  });

  it('getTasksByProject filters by project', async () => {
    const store = new TaskStore();
    store.createTodoTask({ projectId: 'proj-a', prompt: 'a1', workDir: '/tmp' });
    store.createTodoTask({ projectId: 'proj-b', prompt: 'b1', workDir: '/tmp' });
    store.createTodoTask({ projectId: 'proj-a', prompt: 'a2', workDir: '/tmp' });

    const projATasks = store.getTasksByProject('proj-a');
    assert.equal(projATasks.length, 2);
    assert.ok(projATasks.every(t => t.projectId === 'proj-a'));

    const projBTasks = store.getTasksByProject('proj-b');
    assert.equal(projBTasks.length, 1);
  });

  it('getTasksByStatus filters by status', () => {
    const store = new TaskStore();
    store.createTodoTask({ projectId: PROJECT_ID, prompt: 'todo1', workDir: '/tmp' });
    store.createTodoTask({ projectId: PROJECT_ID, prompt: 'todo2', workDir: '/tmp' });

    const todos = store.getTasksByStatus('todo');
    assert.equal(todos.length, 2);
    assert.ok(todos.every(t => t.status === 'todo'));
  });

  it('toSummary returns correct shape', () => {
    const store = new TaskStore();
    const id = store.createTodoTask({ projectId: PROJECT_ID, prompt: 'test', workDir: '/tmp' });
    const task = store.getTask(id)!;
    const summary = store.toSummary(task);

    assert.equal(summary.id, id);
    assert.equal(summary.prompt, 'test');
    assert.equal(summary.projectId, PROJECT_ID);
    assert.equal(summary.status, 'todo');
    assert.equal(summary.runId, null);
    assert.ok('createdAt' in summary);
  });

  it('registerTask inserts a pre-built task', () => {
    const store = new TaskStore();
    const task: ManagedTask = {
      id: 'restored-task',
      prompt: 'from disk',
      workDir: '/tmp',
      projectId: PROJECT_ID,
      runId: 'run-123',
      status: 'completed',
      orchestrator: null,
      createdAt: new Date().toISOString(),
      taskNumber: 5,
    };
    store.registerTask(task);
    assert.equal(store.getTask('restored-task')?.prompt, 'from disk');
  });
});

describe('mapPermissionMode', () => {
  it('interactive mode: autoApprove=false, dangerouslySkipPermissions=false, permissionMode=interactive', () => {
    const result = mapPermissionMode('interactive');
    assert.equal(result.autoApprove, false);
    assert.equal(result.dangerouslySkipPermissions, false);
    assert.equal(result.permissionMode, 'interactive');
  });

  it('auto-approve mode: autoApprove=true, dangerouslySkipPermissions=false, permissionMode=auto', () => {
    const result = mapPermissionMode('auto-approve');
    assert.equal(result.autoApprove, true);
    assert.equal(result.dangerouslySkipPermissions, false);
    assert.equal(result.permissionMode, 'auto');
  });

  it('yolo mode: autoApprove=true, dangerouslySkipPermissions=true, permissionMode=auto', () => {
    const result = mapPermissionMode('yolo');
    assert.equal(result.autoApprove, true);
    assert.equal(result.dangerouslySkipPermissions, true);
    assert.equal(result.permissionMode, 'auto');
  });

  it('undefined falls back to provided autoApprove=true', () => {
    const result = mapPermissionMode(undefined, true);
    assert.equal(result.autoApprove, true);
    assert.equal(result.dangerouslySkipPermissions, false);
    assert.equal(result.permissionMode, 'auto');
  });

  it('undefined falls back to provided autoApprove=false', () => {
    const result = mapPermissionMode(undefined, false);
    assert.equal(result.autoApprove, false);
    assert.equal(result.dangerouslySkipPermissions, false);
    assert.equal(result.permissionMode, 'auto');
  });

  it('undefined with no autoApprove defaults to false', () => {
    const result = mapPermissionMode(undefined);
    assert.equal(result.autoApprove, false);
    assert.equal(result.dangerouslySkipPermissions, false);
    assert.equal(result.permissionMode, 'auto');
  });
});
