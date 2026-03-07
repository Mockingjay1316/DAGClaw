import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import { createTasksRouter } from '../src/routes/tasks.ts';
import { createStagesRouter } from '../src/routes/stages.ts';

// ── Mock TaskStore ──────────────────────────────────────────────────────────

function createMockTaskStore() {
  const tasks = new Map<string, any>();

  return {
    async createTask(opts: { prompt: string; workDir: string }): Promise<string> {
      const id = 'task-' + (tasks.size + 1);
      tasks.set(id, {
        id,
        prompt: opts.prompt,
        workDir: opts.workDir,
        status: 'running',
        runId: null,
        orchestrator: null,
      });
      return id;
    },

    getTask(id: string) {
      return tasks.get(id);
    },

    listTasks() {
      return Array.from(tasks.values());
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
  };
}

// ── Test setup ──────────────────────────────────────────────────────────────

let server: http.Server;
let baseUrl: string;
let mockStore: ReturnType<typeof createMockTaskStore>;
const testWorkDir = process.env.HOME || '/tmp';

before(async () => {
  // Allow testWorkDir for path traversal checks
  process.env.CLAW_ALLOWED_DIR = testWorkDir;
  // Disable rate limiting for route tests
  process.env.CLAW_RATE_LIMIT_MAX = '1000';
  mockStore = createMockTaskStore();

  const app = express();
  app.use(express.json());
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
});

// ── Task routes ─────────────────────────────────────────────────────────────

describe('Task routes', () => {
  it('POST /api/tasks → 201 with { id }', async () => {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'test', workDir: testWorkDir }),
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
    // Create a task first so we know the id
    const createRes = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'detail test', workDir: testWorkDir }),
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
      body: JSON.stringify({ prompt: 'approve test', workDir: testWorkDir }),
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
      body: JSON.stringify({ prompt: 'reject test', workDir: testWorkDir }),
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
      body: JSON.stringify({ prompt: 'cancel test', workDir: testWorkDir }),
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
      body: JSON.stringify({ workDir: testWorkDir }),
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
      body: JSON.stringify({ prompt: '', workDir: testWorkDir }),
    });
    assert.equal(res.status, 400);
  });

  it('POST /api/tasks with missing workDir returns 400', async () => {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'test' }),
    });
    assert.equal(res.status, 400);
  });

  it('POST /api/tasks with empty workDir returns 400', async () => {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'test', workDir: '' }),
    });
    assert.equal(res.status, 400);
  });

  it('POST /api/tasks with non-string prompt returns 400', async () => {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 123, workDir: testWorkDir }),
    });
    assert.equal(res.status, 400);
  });

  it('POST /api/tasks with invalid pipeline returns 400', async () => {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'test', workDir: testWorkDir, pipeline: 'not-array' }),
    });
    assert.equal(res.status, 400);
  });

  it('POST /api/tasks with invalid autoApprove returns 400', async () => {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'test', workDir: testWorkDir, autoApprove: 'yes' }),
    });
    assert.equal(res.status, 400);
  });

  it('POST /api/tasks with valid optional fields returns 201', async () => {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'test', workDir: testWorkDir, pipeline: ['Plan', 'Execute'], autoApprove: true }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.ok(body.id);
  });
});

// ── Path traversal prevention ────────────────────────────────────────────────

describe('Path traversal prevention', () => {
  it('POST /api/tasks with workDir outside allowed directory returns 400', async () => {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'test', workDir: '/etc' }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /outside allowed directory/i);
  });

  it('POST /api/tasks with traversal attempt returns 400', async () => {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'test', workDir: testWorkDir + '/../../etc' }),
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
