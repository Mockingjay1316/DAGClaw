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

  // POST /api/tasks — create a new task (backward-compatible, requires projectId)
  router.post('/api/tasks', taskLimiter, async (req: Request, res: Response) => {
    try {
      const { prompt, workDir, pipeline, autoApprove, permissionMode, projectId } = req.body ?? {};

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
      // Path traversal prevention
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
      if (typeof projectId !== 'string' || projectId.trim() === '') {
        res.status(400).json({ error: 'projectId must be a non-empty string' });
        return;
      }

      const id = await taskStore.createTask({ prompt, workDir: resolvedDir, projectId, pipeline, autoApprove, permissionMode });
      const task = taskStore.getTask(id);
      res.status(201).json(task ? taskStore.toSummary(task) : { id, prompt, workDir: resolvedDir, status: 'queued', runId: null });
    } catch (err) {
      console.error('[tasks] Error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/tasks — list all tasks (supports ?projectId= and ?status= filters)
  router.get('/api/tasks', async (_req: Request, res: Response) => {
    try {
      let tasks = taskStore.listTasks();

      const projectId = _req.query.projectId as string | undefined;
      if (projectId) {
        tasks = tasks.filter(t => t.projectId === projectId);
      }

      const status = _req.query.status as string | undefined;
      if (status) {
        tasks = tasks.filter(t => t.status === status);
      }

      const summaries = tasks.map(t => taskStore.toSummary(t));
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
        ...taskStore.toSummary(task),
        hasPendingApproval: !!task.pendingApproval,
        pendingApprovalMessage: task.pendingApproval?.message,
      });
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

  // POST /api/tasks/:id/execute — move TODO task to queued
  router.post('/api/tasks/:id/execute', async (req: Request, res: Response) => {
    try {
      const id = req.params.id as string;
      const result = taskStore.executeTask(id);
      if (result.error) {
        res.status(result.status!).json({ error: result.error });
        return;
      }
      const task = taskStore.getTask(id);
      res.status(200).json(task ? taskStore.toSummary(task) : { id, status: 'queued' });
    } catch (err) {
      console.error('[tasks] Error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
