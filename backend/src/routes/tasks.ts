import { Router } from 'express';
import { resolve } from 'node:path';
import type { Request, Response } from 'express';
import { TaskStore, type ApiPermissionMode } from '../taskStore.ts';
import { RunLogger } from '../../../core/runLogger.ts';
import { createRateLimiter } from '../middleware/rateLimit.ts';

const VALID_PERMISSION_MODES: ApiPermissionMode[] = ['interactive', 'auto-approve', 'yolo'];

export function createTasksRouter(taskStore: TaskStore): Router {
  const router = Router();
  const rateMax = parseInt(process.env.CLAW_RATE_LIMIT_MAX || '10', 10);
  const taskLimiter = createRateLimiter({ windowMs: 60_000, max: rateMax });

  // POST /api/tasks — create a new task
  router.post('/api/tasks', taskLimiter, async (req: Request, res: Response) => {
    try {
      const { prompt, workDir, pipeline, autoApprove, permissionMode } = req.body ?? {};

      if (typeof prompt !== 'string' || prompt.trim() === '') {
        res.status(400).json({ error: 'prompt must be a non-empty string' });
        return;
      }
      if (prompt.length > 10_000) {
        res.status(400).json({ error: 'prompt must be at most 10000 characters' });
        return;
      }
      if (typeof workDir !== 'string' || workDir.trim() === '') {
        res.status(400).json({ error: 'workDir must be a non-empty string' });
        return;
      }
      // Fix #3: Path traversal prevention
      const resolvedDir = resolve(workDir);
      const allowedBase = process.env.CLAW_ALLOWED_DIR || process.env.HOME || '/';
      if (!resolvedDir.startsWith(resolve(allowedBase))) {
        res.status(400).json({ error: 'workDir is outside allowed directory' });
        return;
      }
      if (pipeline !== undefined && (!Array.isArray(pipeline) || !pipeline.every((s: unknown) => typeof s === 'string'))) {
        res.status(400).json({ error: 'pipeline must be an array of strings' });
        return;
      }
      if (pipeline !== undefined && pipeline.length > 20) {
        res.status(400).json({ error: 'pipeline must have at most 20 stages' });
        return;
      }
      if (autoApprove !== undefined && typeof autoApprove !== 'boolean') {
        res.status(400).json({ error: 'autoApprove must be a boolean' });
        return;
      }
      if (permissionMode !== undefined && !VALID_PERMISSION_MODES.includes(permissionMode)) {
        res.status(400).json({ error: `permissionMode must be one of: ${VALID_PERMISSION_MODES.join(', ')}` });
        return;
      }

      const id = await taskStore.createTask({ prompt, workDir: resolvedDir, pipeline, autoApprove, permissionMode });
      res.status(201).json({ id, prompt, workDir: resolvedDir, status: 'running', runId: null });
    } catch (err) {
      console.error('[tasks] Error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/tasks — list all tasks
  router.get('/api/tasks', async (_req: Request, res: Response) => {
    try {
      const tasks = taskStore.listTasks();
      const summaries = tasks.map(t => ({
        id: t.id,
        prompt: t.prompt,
        workDir: t.workDir,
        status: t.status,
        runId: t.runId,
        error: t.error,
      }));
      res.status(200).json(summaries);
    } catch (err) {
      console.error('[tasks] Error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/tasks/:id — get task detail
  router.get('/api/tasks/:id', async (req: Request, res: Response) => {
    try {
      const id = req.params.id as string;
      const task = taskStore.getTask(id);
      if (!task) {
        res.status(404).json({ error: 'Task not found' });
        return;
      }
      res.status(200).json({
        id: task.id,
        prompt: task.prompt,
        workDir: task.workDir,
        status: task.status,
        runId: task.runId,
        error: task.error,
        hasPendingApproval: !!task.pendingApproval,
        pendingApprovalMessage: task.pendingApproval?.message,
      });
    } catch (err) {
      console.error('[tasks] Error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/tasks/:id/tree — get task tree from run manifest
  router.get('/api/tasks/:id/tree', async (req: Request, res: Response) => {
    try {
      const id = req.params.id as string;
      const task = taskStore.getTask(id);
      if (!task) {
        res.status(404).json({ error: 'Task not found' });
        return;
      }
      if (!task.runId) {
        res.status(404).json({ error: 'No run associated with task' });
        return;
      }
      const logger = new RunLogger(task.workDir);
      let manifest;
      try {
        manifest = logger.readManifest(task.runId);
      } catch (readErr: unknown) {
        if (readErr && typeof readErr === 'object' && 'code' in readErr && (readErr as { code: string }).code === 'ENOENT') {
          res.status(404).json({ error: 'Run manifest not found' });
          return;
        }
        console.error('[tasks] Error reading manifest:', readErr);
        res.status(500).json({ error: 'Internal server error' });
        return;
      }
      res.status(200).json(manifest.tree);
    } catch (err) {
      console.error('[tasks] Error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/tasks/:id/usage — get task usage from run manifest
  router.get('/api/tasks/:id/usage', async (req: Request, res: Response) => {
    try {
      const id = req.params.id as string;
      const task = taskStore.getTask(id);
      if (!task) {
        res.status(404).json({ error: 'Task not found' });
        return;
      }
      if (!task.runId) {
        res.status(404).json({ error: 'No run data available yet' });
        return;
      }
      const logger = new RunLogger(task.workDir);
      let manifest;
      try {
        manifest = logger.readManifest(task.runId);
      } catch {
        res.status(404).json({ error: 'Run data not found' });
        return;
      }
      res.status(200).json({ taskId: task.id, usage: manifest.usage });
    } catch (err) {
      console.error('[tasks] Error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/tasks/:id/approve — approve a pending task
  router.post('/api/tasks/:id/approve', async (req: Request, res: Response) => {
    try {
      const id = req.params.id as string;
      const approved = taskStore.approveTask(id);
      if (!approved) {
        res.status(404).json({ error: 'Task not found or no pending approval' });
        return;
      }
      res.status(200).json({ approved: true });
    } catch (err) {
      console.error('[tasks] Error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/tasks/:id/reject — reject a pending task
  router.post('/api/tasks/:id/reject', async (req: Request, res: Response) => {
    try {
      const id = req.params.id as string;
      const { feedback } = req.body ?? {};
      const rejected = taskStore.rejectTask(id, feedback);
      if (!rejected) {
        res.status(404).json({ error: 'Task not found or no pending approval' });
        return;
      }
      res.status(200).json({ rejected: true });
    } catch (err) {
      console.error('[tasks] Error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // DELETE /api/tasks/:id — cancel a task
  router.delete('/api/tasks/:id', async (req: Request, res: Response) => {
    try {
      const id = req.params.id as string;
      const cancelled = taskStore.cancelTask(id);
      if (!cancelled) {
        res.status(404).json({ error: 'Task not found' });
        return;
      }
      res.status(200).json({ cancelled: true });
    } catch (err) {
      console.error('[tasks] Error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/tasks/:id/retry — retry a failed/cancelled task
  router.post('/api/tasks/:id/retry', async (req: Request, res: Response) => {
    try {
      const id = req.params.id as string;
      const result = await taskStore.retryTask(id);
      if ('error' in result) {
        res.status(result.status).json({ error: result.error });
        return;
      }
      res.status(201).json({ id: result.newId });
    } catch (err) {
      console.error('[tasks] Error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
