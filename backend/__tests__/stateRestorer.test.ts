import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { restoreState } from '../src/stateRestorer.ts';
import { TaskStore } from '../src/taskStore.ts';
import type { Project } from '../src/projectStore.ts';

let tmpDir: string;

function setup(): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dagclaw-restore-'));
  return tmpDir;
}

function cleanup(): void {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
}

function makeProject(projectPath: string): Project {
  return {
    id: 'proj-' + path.basename(projectPath),
    name: path.basename(projectPath),
    path: projectPath,
    addedAt: new Date().toISOString(),
  };
}

describe('stateRestorer', () => {
  beforeEach(() => setup());
  afterEach(() => cleanup());

  it('restores TODO tasks from tasks.json', () => {
    const projDir = path.join(tmpDir, 'proj1');
    fs.mkdirSync(path.join(projDir, '.dagclaw'), { recursive: true });

    const tasksData = {
      tasks: [
        { id: 'todo-1', prompt: 'do something', createdAt: '2024-01-01T00:00:00Z' },
        { id: 'todo-2', prompt: 'do another', pipeline: ['Plan', 'Execute'], createdAt: '2024-01-02T00:00:00Z' },
      ],
    };
    fs.writeFileSync(path.join(projDir, '.dagclaw', 'tasks.json'), JSON.stringify(tasksData));

    const store = new TaskStore();
    const project = makeProject(projDir);
    const results = restoreState([project], store);

    assert.equal(results.length, 1);
    assert.equal(results[0].todoCount, 2);

    const tasks = store.listTasks();
    assert.equal(tasks.length, 2);
    assert.equal(tasks[0].status, 'todo');
    assert.equal(tasks[1].status, 'todo');
  });

  it('restores completed runs as completed tasks', () => {
    const projDir = path.join(tmpDir, 'proj2');
    const runDir = path.join(projDir, '.dagclaw', 'runs', '2024-01-01_00-00-00_abc12345');
    fs.mkdirSync(runDir, { recursive: true });

    const manifest = {
      prompt: 'build feature',
      status: 'completed',
      pipeline: ['Plan', 'Execute', 'Verify'],
      startedAt: '2024-01-01T00:00:00Z',
    };
    fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify(manifest));

    const store = new TaskStore();
    const project = makeProject(projDir);
    const results = restoreState([project], store);

    assert.equal(results[0].completedCount, 1);
    const tasks = store.listTasks();
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].status, 'completed');
    assert.equal(tasks[0].runId, '2024-01-01_00-00-00_abc12345');
  });

  it('restores running manifests as failed with interrupted error', () => {
    const projDir = path.join(tmpDir, 'proj3');
    const runDir = path.join(projDir, '.dagclaw', 'runs', '2024-01-01_00-00-00_running1');
    fs.mkdirSync(runDir, { recursive: true });

    const manifest = {
      prompt: 'interrupted task',
      status: 'running',
      startedAt: '2024-01-01T00:00:00Z',
    };
    fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify(manifest));

    const store = new TaskStore();
    const project = makeProject(projDir);
    const results = restoreState([project], store);

    assert.equal(results[0].interruptedCount, 1);
    const tasks = store.listTasks();
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].status, 'failed');
    assert.equal(tasks[0].error, 'Interrupted by server restart');
  });

  it('handles missing .dagclaw directory gracefully', () => {
    const projDir = path.join(tmpDir, 'proj4');
    fs.mkdirSync(projDir);

    const store = new TaskStore();
    const project = makeProject(projDir);
    const results = restoreState([project], store);

    assert.equal(results[0].todoCount, 0);
    assert.equal(results[0].completedCount, 0);
    assert.equal(store.listTasks().length, 0);
  });

  it('handles corrupt manifest gracefully', () => {
    const projDir = path.join(tmpDir, 'proj5');
    const runDir = path.join(projDir, '.dagclaw', 'runs', '2024-01-01_00-00-00_corrupt');
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'manifest.json'), 'not valid json{{{');

    const store = new TaskStore();
    const project = makeProject(projDir);
    const results = restoreState([project], store);

    // Should not crash
    assert.equal(results[0].completedCount, 0);
    assert.equal(store.listTasks().length, 0);
  });

  it('restores multiple projects', () => {
    // Project A: 1 todo + 1 completed
    const projA = path.join(tmpDir, 'projA');
    fs.mkdirSync(path.join(projA, '.dagclaw', 'runs', 'run-a'), { recursive: true });
    fs.writeFileSync(
      path.join(projA, '.dagclaw', 'tasks.json'),
      JSON.stringify({ tasks: [{ id: 'todo-a', prompt: 'a-todo', createdAt: '2024-01-01T00:00:00Z' }] }),
    );
    fs.writeFileSync(
      path.join(projA, '.dagclaw', 'runs', 'run-a', 'manifest.json'),
      JSON.stringify({ prompt: 'a-done', status: 'completed', startedAt: '2024-01-01T00:00:00Z' }),
    );

    // Project B: 1 failed
    const projB = path.join(tmpDir, 'projB');
    fs.mkdirSync(path.join(projB, '.dagclaw', 'runs', 'run-b'), { recursive: true });
    fs.writeFileSync(
      path.join(projB, '.dagclaw', 'runs', 'run-b', 'manifest.json'),
      JSON.stringify({ prompt: 'b-fail', status: 'failed', startedAt: '2024-01-01T00:00:00Z' }),
    );

    const store = new TaskStore();
    const results = restoreState(
      [makeProject(projA), makeProject(projB)],
      store,
    );

    assert.equal(results.length, 2);
    assert.equal(results[0].todoCount, 1);
    assert.equal(results[0].completedCount, 1);
    assert.equal(results[1].failedCount, 1);
    assert.equal(store.listTasks().length, 3);
  });
});
