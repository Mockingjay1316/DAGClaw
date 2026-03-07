import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TaskStore, ManagedTask } from '../src/taskStore.ts';

describe('TaskStore', () => {
  it('createTask returns a task id string', async () => {
    const store = new TaskStore();
    const id = await store.createTask({ prompt: 'test task', workDir: '/tmp' });
    assert.equal(typeof id, 'string');
    assert.ok(id.length > 0);
  });

  it('getTask returns the created task', async () => {
    const store = new TaskStore();
    const id = await store.createTask({ prompt: 'hello', workDir: '/tmp' });
    const task = store.getTask(id);
    assert.ok(task);
    assert.equal(task.id, id);
    assert.equal(task.prompt, 'hello');
    assert.equal(task.workDir, '/tmp');
  });

  it('getTask returns undefined for non-existent id', () => {
    const store = new TaskStore();
    assert.equal(store.getTask('non-existent'), undefined);
  });

  it('listTasks returns all tasks', async () => {
    const store = new TaskStore();
    const id1 = await store.createTask({ prompt: 'task 1', workDir: '/tmp' });
    const id2 = await store.createTask({ prompt: 'task 2', workDir: '/tmp' });
    const tasks = store.listTasks();
    assert.equal(tasks.length, 2);
    const ids = tasks.map(t => t.id);
    assert.ok(ids.includes(id1));
    assert.ok(ids.includes(id2));
  });

  it('approveTask resolves pending approval', () => {
    const store = new TaskStore();
    // Manually insert a task with pendingApproval to test approval flow
    // without needing a real orchestrator
    let resolved: boolean | undefined;
    const task: ManagedTask = {
      id: 'test-approve',
      prompt: 'approve me',
      workDir: '/tmp',
      runId: null,
      status: 'pending',
      orchestrator: null,
      pendingApproval: {
        resolve: (val: boolean) => { resolved = val; },
        message: 'Please approve',
      },
    };
    // Access private map via any cast
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
      runId: null,
      status: 'pending',
      orchestrator: null,
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
      runId: null,
      status: 'running',
      orchestrator: { shutdown: () => { shutdownCalled = true; } } as any,
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

  it('constructor accepts custom stages and passes them to orchestrator', () => {
    const customStages = { 'Lint': {} as any };
    const store = new TaskStore(customStages);
    // Verify the store was constructed without errors and stores the reference
    assert.ok(store);
    assert.equal((store as any).customStagesRef, customStages);
  });

  it('approveTask on task without pending approval returns false', () => {
    const store = new TaskStore();
    const task: ManagedTask = {
      id: 'no-approval',
      prompt: 'test',
      workDir: '/tmp',
      runId: null,
      status: 'running',
      orchestrator: null,
    };
    (store as any).tasks.set('no-approval', task);
    assert.equal(store.approveTask('no-approval'), false);
  });
});
