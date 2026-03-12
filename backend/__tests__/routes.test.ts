import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTasksRouter } from '../src/routes/tasks.ts';
import { createStagesRouter } from '../src/routes/stages.ts';
import { createRunsRouter } from '../src/routes/runs.ts';
import type { RunManifest } from '../../core/types.ts';

// ── Mock TaskStore ──────────────────────────────────────────────────────────

const TEST_PROJECT_ID = 'test-project-1';

function createMockTaskStore() {
  const tasks = new Map<string, any>();

  return {
    async createTask(opts: { prompt: string; workDir: string; projectId: string }): Promise<string> {
      const id = 'task-' + (tasks.size + 1);
      tasks.set(id, {
        id,
        prompt: opts.prompt,
        workDir: opts.workDir,
        projectId: opts.projectId,
        status: 'running',
        runId: null,
        orchestrator: null,
        createdAt: new Date().toISOString(),
      });
      return id;
    },

    getTask(id: string) {
      return tasks.get(id);
    },

    listTasks() {
      return Array.from(tasks.values());
    },

    toSummary(task: any) {
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
    },

    approveTask(id: string): boolean {
      const task = tasks.get(id);
      if (!task) return false;
      task.status = 'running';
      return true;
    },

    rejectTask(id: string, _feedback?: string): boolean {
      const task = tasks.get(id);
      if (!task) return false;
      task.status = 'failed';
      return true;
    },

    cancelTask(id: string): boolean {
      const task = tasks.get(id);
      if (!task) return false;
      task.status = 'cancelled';
      return true;
    },

    executeTask(id: string): { error?: string; status?: number } {
      const task = tasks.get(id);
      if (!task) return { error: 'Task not found', status: 404 };
      task.status = 'queued';
      return {};
    },

    async retryTask(id: string): Promise<{ newId: string } | { error: string; status: number }> {
      const task = tasks.get(id);
      if (!task) return { error: 'Task not found', status: 404 };
      if (task.status === 'running') return { error: 'Task is still running', status: 400 };
      const newId = 'task-' + (tasks.size + 1);
      tasks.set(newId, {
        id: newId,
        prompt: task.prompt,
        workDir: task.workDir,
        projectId: task.projectId,
        status: 'running',
        runId: null,
        orchestrator: null,
        createdAt: new Date().toISOString(),
      });
      return { newId };
    },
  };
}

// ── Test fixtures ───────────────────────────────────────────────────────────

function createTestManifest(id: string, overrides?: Partial<RunManifest>): RunManifest {
  return {
    id,
    prompt: `Test task ${id}`,
    workDir: '/tmp/test',
    pipeline: ['Plan', 'Execute', 'Verify'],
    backend: 'claude-cli',
    permissionMode: 'interactive',
    status: 'completed',
    startedAt: '2026-03-09T10:00:00.000Z',
    completedAt: '2026-03-09T10:05:00.000Z',
    duration: 300000,
    usage: {
      totalInputTokens: 1000,
      totalOutputTokens: 500,
      totalCacheReadTokens: 200,
      estimatedCost: 0.05,
      perStage: {},
      perSubtask: {},
    },
    ...overrides,
  };
}

// ── Test setup ──────────────────────────────────────────────────────────────

let server: http.Server;
let baseUrl: string;
let mockStore: ReturnType<typeof createMockTaskStore>;
let tempWorkDir: string;
const testWorkDir = process.env.HOME || '/tmp';

before(async () => {
  // Create temp directory with .dagclaw/runs/ structure for run history tests
  tempWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dagclaw-test-'));
  const runsDir = path.join(tempWorkDir, '.dagclaw', 'runs');

  // Create two test runs with manifest files
  const run1Id = '2026-03-09T10-00-00_aaaaaaaa';
  const run2Id = '2026-03-09T10-10-00_bbbbbbbb';

  const run1Dir = path.join(runsDir, run1Id);
  const run2Dir = path.join(runsDir, run2Id);
  fs.mkdirSync(run1Dir, { recursive: true });
  fs.mkdirSync(run2Dir, { recursive: true });

  fs.writeFileSync(
    path.join(run1Dir, 'manifest.json'),
    JSON.stringify(createTestManifest(run1Id)),
  );
  fs.writeFileSync(
    path.join(run2Dir, 'manifest.json'),
    JSON.stringify(createTestManifest(run2Id, {
      prompt: 'Second test task',
      status: 'running',
      startedAt: '2026-03-09T10:10:00.000Z',
      completedAt: null,
      duration: null,
      usage: {
        totalInputTokens: 2000,
        totalOutputTokens: 1000,
        totalCacheReadTokens: 400,
        estimatedCost: 0.10,
        perStage: {},
        perSubtask: {},
      },
    })),
  );

  // Allow both testWorkDir and tempWorkDir for path traversal checks
  process.env.CLAW_ALLOWED_DIR = testWorkDir;
  // Disable rate limiting for route tests
  process.env.CLAW_RATE_LIMIT_MAX = '1000';
  mockStore = createMockTaskStore();

  const app = express();
  app.use(express.json());
  app.use(createRunsRouter(tempWorkDir));
  app.use(createTasksRouter(mockStore as any));
  app.use(createStagesRouter({}));
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  server = http.createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, () => resolve());
  });

  const addr = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  // Clean up temp directory
  fs.rmSync(tempWorkDir, { recursive: true, force: true });
});

// ── Task routes ─────────────────────────────────────────────────────────────

describe('Task routes', () => {
  it('POST /api/tasks → 201 with { id }', async () => {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'test', workDir: testWorkDir, projectId: TEST_PROJECT_ID }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.ok(body.id, 'response should have an id');
  });

  it('GET /api/tasks → 200 with array', async () => {
    const res = await fetch(`${baseUrl}/api/tasks`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body), 'response should be an array');
  });

  it('GET /api/tasks/:id → 200 with task detail', async () => {
    const createRes = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'detail test', workDir: testWorkDir, projectId: TEST_PROJECT_ID }),
    });
    const { id } = await createRes.json();

    const res = await fetch(`${baseUrl}/api/tasks/${id}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.id, id);
    assert.equal(body.prompt, 'detail test');
  });

  it('GET /api/tasks/:id with unknown id → 404', async () => {
    const res = await fetch(`${baseUrl}/api/tasks/nonexistent-id`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.ok(body.error);
  });

  it('POST /api/tasks/:id/approve → 200 { approved: true }', async () => {
    const createRes = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'approve test', workDir: testWorkDir, projectId: TEST_PROJECT_ID }),
    });
    const { id } = await createRes.json();

    const res = await fetch(`${baseUrl}/api/tasks/${id}/approve`, { method: 'POST' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.approved, true);
  });

  it('POST /api/tasks/:id/reject with feedback → 200 { rejected: true }', async () => {
    const createRes = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'reject test', workDir: testWorkDir, projectId: TEST_PROJECT_ID }),
    });
    const { id } = await createRes.json();

    const res = await fetch(`${baseUrl}/api/tasks/${id}/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ feedback: 'bad plan' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.rejected, true);
  });

  it('DELETE /api/tasks/:id → 200 { cancelled: true }', async () => {
    const createRes = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'cancel test', workDir: testWorkDir, projectId: TEST_PROJECT_ID }),
    });
    const { id } = await createRes.json();

    const res = await fetch(`${baseUrl}/api/tasks/${id}`, { method: 'DELETE' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.cancelled, true);
  });
});

// ── Task input validation ───────────────────────────────────────────────────

describe('Task input validation', () => {
  it('POST /api/tasks with missing prompt returns 400', async () => {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workDir: testWorkDir, projectId: TEST_PROJECT_ID }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(typeof body.error, 'string');
    assert.match(body.error, /prompt/i);
  });

  it('POST /api/tasks with empty prompt returns 400', async () => {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: '', workDir: testWorkDir, projectId: TEST_PROJECT_ID }),
    });
    assert.equal(res.status, 400);
  });

  it('POST /api/tasks with missing workDir returns 400', async () => {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'test', projectId: TEST_PROJECT_ID }),
    });
    assert.equal(res.status, 400);
  });

  it('POST /api/tasks with empty workDir returns 400', async () => {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'test', workDir: '', projectId: TEST_PROJECT_ID }),
    });
    assert.equal(res.status, 400);
  });

  it('POST /api/tasks with non-string prompt returns 400', async () => {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 123, workDir: testWorkDir, projectId: TEST_PROJECT_ID }),
    });
    assert.equal(res.status, 400);
  });

  it('POST /api/tasks with invalid pipeline returns 400', async () => {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'test', workDir: testWorkDir, projectId: TEST_PROJECT_ID, pipeline: 'not-array' }),
    });
    assert.equal(res.status, 400);
  });

  it('POST /api/tasks with invalid autoApprove returns 400', async () => {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'test', workDir: testWorkDir, projectId: TEST_PROJECT_ID, autoApprove: 'yes' }),
    });
    assert.equal(res.status, 400);
  });

  it('POST /api/tasks with valid permissionMode=yolo returns 201', async () => {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'test', workDir: testWorkDir, projectId: TEST_PROJECT_ID, permissionMode: 'yolo' }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.ok(body.id);
  });

  it('POST /api/tasks with invalid permissionMode returns 400', async () => {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'test', workDir: testWorkDir, projectId: TEST_PROJECT_ID, permissionMode: 'invalid' }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /permissionMode/i);
  });

  it('POST /api/tasks with permissionMode and autoApprove both sent works (permissionMode takes precedence)', async () => {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'test', workDir: testWorkDir, projectId: TEST_PROJECT_ID, permissionMode: 'auto-approve', autoApprove: false }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.ok(body.id);
  });

  it('POST /api/tasks with valid optional fields returns 201', async () => {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'test', workDir: testWorkDir, projectId: TEST_PROJECT_ID, pipeline: ['Plan', 'Execute'], autoApprove: true }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.ok(body.id);
  });

  it('POST /api/tasks with missing projectId returns 400', async () => {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'test', workDir: testWorkDir }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /projectId/i);
  });
});

// ── Path traversal prevention ────────────────────────────────────────────────

describe('Path traversal prevention', () => {
  it('POST /api/tasks with workDir outside allowed directory returns 400', async () => {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'test', workDir: '/etc', projectId: TEST_PROJECT_ID }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /outside allowed directory/i);
  });

  it('POST /api/tasks with traversal attempt returns 400', async () => {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'test', workDir: testWorkDir + '/../../etc', projectId: TEST_PROJECT_ID }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /outside allowed directory/i);
  });
});

// ── Stage routes ────────────────────────────────────────────────────────────

describe('Stage routes', () => {
  it('GET /api/stages → 200 with array of stages', async () => {
    const res = await fetch(`${baseUrl}/api/stages`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body), 'response should be an array');
    assert.ok(body.length > 0, 'should have built-in stages');
    const names = body.map((s: any) => s.name);
    assert.ok(names.includes('Plan'), 'should include Plan stage');
    assert.ok(names.includes('Execute'), 'should include Execute stage');
    assert.ok(names.includes('Verify'), 'should include Verify stage');
  });

  it('POST /api/stages with invalid body → 400', async () => {
    const res = await fetch(`${baseUrl}/api/stages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok(body.errors);
  });

  it('DELETE /api/stages/Plan → 409 (cannot delete built-in)', async () => {
    const res = await fetch(`${baseUrl}/api/stages/Plan`, { method: 'DELETE' });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.ok(body.error);
    assert.match(body.error, /built-in/i);
  });
});

// ── Health route ────────────────────────────────────────────────────────────

describe('Health route', () => {
  it('GET /api/health → 200 { status: ok }', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { status: 'ok' });
  });
});

// ── Run history routes ──────────────────────────────────────────────────────

describe('Run history routes', () => {
  it('GET /api/runs → 200 with array of run summaries', async () => {
    const res = await fetch(`${baseUrl}/api/runs`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body), 'response should be an array');
    assert.equal(body.length, 2, 'should return 2 test runs');
    // Should be sorted by most recent first
    assert.ok(body[0].id.includes('bbbbbbbb'), 'most recent run should be first');
    assert.ok(body[1].id.includes('aaaaaaaa'), 'older run should be second');
    // Verify summary fields
    assert.equal(typeof body[0].prompt, 'string');
    assert.equal(typeof body[0].status, 'string');
    assert.equal(typeof body[0].startedAt, 'string');
    assert.equal(typeof body[0].estimatedCost, 'number');
  });

  it('GET /api/runs/:id → 200 with full manifest when run exists', async () => {
    const runId = '2026-03-09T10-00-00_aaaaaaaa';
    const res = await fetch(`${baseUrl}/api/runs/${runId}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.id, runId);
    assert.equal(body.prompt, `Test task ${runId}`);
    assert.equal(body.status, 'completed');
    assert.ok(body.usage, 'should have usage field');
    assert.equal(body.usage.totalInputTokens, 1000);
    assert.ok(body.pipeline, 'should have pipeline field');
  });

  it('GET /api/runs/:id → 404 when run not found', async () => {
    const res = await fetch(`${baseUrl}/api/runs/nonexistent-run-id`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.ok(body.error);
  });
});

// ── Task usage routes ───────────────────────────────────────────────────────

describe('Task usage routes', () => {
  it('GET /api/tasks/:id/usage → 200 with usage data when task has runId', async () => {
    const createRes = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'usage test', workDir: testWorkDir, projectId: TEST_PROJECT_ID }),
    });
    const { id } = await createRes.json();
    // Directly set the task's runId and workDir on the mock store
    const task = mockStore.getTask(id);
    task.runId = '2026-03-09T10-00-00_aaaaaaaa';
    task.workDir = tempWorkDir;

    const res = await fetch(`${baseUrl}/api/tasks/${id}/usage`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.usage, 'should have usage field');
    assert.ok(body.usage.totalInputTokens !== undefined, 'should have totalInputTokens');
    assert.ok(body.usage.totalOutputTokens !== undefined, 'should have totalOutputTokens');
    assert.equal(body.usage.estimatedCost, 0.05);
    assert.equal(body.taskId, id, 'should include taskId');
  });

  it('GET /api/tasks/:id/usage → 404 when task not found', async () => {
    const res = await fetch(`${baseUrl}/api/tasks/nonexistent-task/usage`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.ok(body.error);
  });

  it('GET /api/tasks/:id/usage → 404 when task has no runId', async () => {
    const createRes = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'no-run test', workDir: testWorkDir, projectId: TEST_PROJECT_ID }),
    });
    const { id } = await createRes.json();

    const res = await fetch(`${baseUrl}/api/tasks/${id}/usage`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.ok(body.error);
  });
});

// ── Task retry routes ──────────────────────────────────────────────────────

describe('Task retry routes', () => {
  it('POST /api/tasks/:id/retry → 201 with new task id when original task is failed', async () => {
    const createRes = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'retry test', workDir: testWorkDir, projectId: TEST_PROJECT_ID }),
    });
    const { id } = await createRes.json();
    mockStore.getTask(id).status = 'failed';

    const res = await fetch(`${baseUrl}/api/tasks/${id}/retry`, { method: 'POST' });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.ok(body.id, 'response should have a new task id');
    assert.notEqual(body.id, id, 'new task id should differ from original');
  });

  it('POST /api/tasks/:id/retry → 404 when task not found', async () => {
    const res = await fetch(`${baseUrl}/api/tasks/nonexistent-id/retry`, { method: 'POST' });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.ok(body.error, 'should have error message');
  });

  it('POST /api/tasks/:id/retry → 400 when task is still running', async () => {
    const createRes = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'running retry test', workDir: testWorkDir, projectId: TEST_PROJECT_ID }),
    });
    const { id } = await createRes.json();

    const res = await fetch(`${baseUrl}/api/tasks/${id}/retry`, { method: 'POST' });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok(body.error, 'should have error message');
    assert.match(body.error, /running/i, 'error should mention task is still running');
  });
});

// ── Task execute endpoint ──────────────────────────────────────────────────

describe('Task execute endpoint', () => {
  it('POST /api/tasks/:id/execute → 200 when task exists', async () => {
    const createRes = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'execute test', workDir: testWorkDir, projectId: TEST_PROJECT_ID }),
    });
    const { id } = await createRes.json();
    // Set it back to "todo" for the execute test
    mockStore.getTask(id).status = 'todo';

    const res = await fetch(`${baseUrl}/api/tasks/${id}/execute`, { method: 'POST' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'queued');
  });

  it('POST /api/tasks/:id/execute → 404 when task not found', async () => {
    const res = await fetch(`${baseUrl}/api/tasks/nonexistent/execute`, { method: 'POST' });
    assert.equal(res.status, 404);
  });
});
