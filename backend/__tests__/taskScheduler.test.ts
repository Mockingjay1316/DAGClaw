import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TaskScheduler } from '../src/taskScheduler.ts';

describe('TaskScheduler', () => {
  it('starts with empty queue and zero running', () => {
    const scheduler = new TaskScheduler(3);
    assert.equal(scheduler.queueLength, 0);
    assert.equal(scheduler.runningCount, 0);
  });

  it('enqueue starts task immediately when under limit', async () => {
    const started: string[] = [];
    const scheduler = new TaskScheduler(2);
    scheduler.onStart(async (taskId) => {
      started.push(taskId);
    });

    scheduler.enqueue('task-1');
    // drain is sync, callback is async but starts immediately
    await new Promise(r => setTimeout(r, 10));
    assert.deepEqual(started, ['task-1']);
    assert.equal(scheduler.runningCount, 1);
  });

  it('respects max concurrent limit', async () => {
    const started: string[] = [];
    const scheduler = new TaskScheduler(2);
    scheduler.onStart(async (taskId) => {
      started.push(taskId);
    });

    scheduler.enqueue('task-1');
    scheduler.enqueue('task-2');
    scheduler.enqueue('task-3');

    await new Promise(r => setTimeout(r, 10));

    // Only 2 should have started
    assert.equal(started.length, 2);
    assert.equal(scheduler.queueLength, 1);
    assert.equal(scheduler.runningCount, 2);
  });

  it('onTaskFinished drains queue', async () => {
    const started: string[] = [];
    const scheduler = new TaskScheduler(1);
    scheduler.onStart(async (taskId) => {
      started.push(taskId);
    });

    scheduler.enqueue('task-1');
    scheduler.enqueue('task-2');

    await new Promise(r => setTimeout(r, 10));
    assert.equal(started.length, 1);

    scheduler.onTaskFinished('task-1');
    await new Promise(r => setTimeout(r, 10));

    assert.equal(started.length, 2);
    assert.deepEqual(started, ['task-1', 'task-2']);
  });

  it('isQueued and isRunning work correctly', async () => {
    const scheduler = new TaskScheduler(1);
    scheduler.onStart(async () => {});

    scheduler.enqueue('a');
    scheduler.enqueue('b');

    await new Promise(r => setTimeout(r, 10));

    assert.equal(scheduler.isRunning('a'), true);
    assert.equal(scheduler.isQueued('a'), false);
    assert.equal(scheduler.isRunning('b'), false);
    assert.equal(scheduler.isQueued('b'), true);
  });

  it('dequeue removes task from queue', async () => {
    const scheduler = new TaskScheduler(1);
    scheduler.onStart(async () => {});

    scheduler.enqueue('a');
    scheduler.enqueue('b');
    scheduler.enqueue('c');

    await new Promise(r => setTimeout(r, 10));

    assert.equal(scheduler.dequeue('b'), true);
    assert.equal(scheduler.queueLength, 1);
    assert.equal(scheduler.dequeue('nonexistent'), false);
  });
});
