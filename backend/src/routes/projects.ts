import { Router } from 'express';
import { resolve } from 'node:path';
import type { Request, Response } from 'express';
import type { ProjectStore } from '../projectStore.ts';
import type { TaskStore } from '../taskStore.ts';

export function createProjectsRouter(projectStore: ProjectStore, taskStore: TaskStore): Router {
  const router = Router();

  // GET /api/projects — list all projects with task counts
  router.get('/api/projects', (_req: Request, res: Response) => {
    try {
      const projects = projectStore.listProjects();
      const result = projects.map(p => {
        const tasks = taskStore.getTasksByProject(p.id);
        const counts: Record<string, number> = {};
        for (const t of tasks) {
          counts[t.status] = (counts[t.status] || 0) + 1;
        }
        return { ...p, taskCounts: counts };
      });
      res.status(200).json(result);
    } catch (err) {
      console.error('[projects] Error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/projects — add a project
  router.post('/api/projects', (req: Request, res: Response) => {
    try {
      const { path: projectPath, name } = req.body ?? {};

      if (typeof projectPath !== 'string' || projectPath.trim() === '') {
        res.status(400).json({ error: 'path must be a non-empty string' });
        return;
      }

      // Validate path is within allowed directory
      const resolvedDir = resolve(projectPath);
      const allowedBase = process.env.CLAW_ALLOWED_DIR || process.env.HOME || '/';
      if (!resolvedDir.startsWith(resolve(allowedBase))) {
        res.status(400).json({ error: 'path is outside allowed directory' });
        return;
      }

      if (name !== undefined && (typeof name !== 'string' || name.trim() === '')) {
        res.status(400).json({ error: 'name must be a non-empty string if provided' });
        return;
      }

      const project = projectStore.addProject(resolvedDir, name);
      res.status(201).json(project);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('does not exist') || msg.includes('not a directory')) {
        res.status(400).json({ error: msg });
      } else if (msg.includes('already exists')) {
        res.status(409).json({ error: msg });
      } else {
        console.error('[projects] Error:', err);
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  });

  // GET /api/projects/:id — project detail
  router.get('/api/projects/:id', (req: Request, res: Response) => {
    try {
      const project = projectStore.getProject(req.params.id as string);
      if (!project) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      const tasks = taskStore.getTasksByProject(project.id);
      const counts: Record<string, number> = {};
      for (const t of tasks) {
        counts[t.status] = (counts[t.status] || 0) + 1;
      }
      res.status(200).json({ ...project, taskCounts: counts });
    } catch (err) {
      console.error('[projects] Error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // DELETE /api/projects/:id — remove a project
  router.delete('/api/projects/:id', (req: Request, res: Response) => {
    try {
      const removed = projectStore.removeProject(req.params.id as string);
      if (!removed) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      res.status(200).json({ removed: true });
    } catch (err) {
      console.error('[projects] Error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/projects/:id/tasks — list tasks for project
  router.get('/api/projects/:id/tasks', (req: Request, res: Response) => {
    try {
      const project = projectStore.getProject(req.params.id as string);
      if (!project) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }

      let tasks = taskStore.getTasksByProject(project.id);

      // Optional status filter
      const statusFilter = typeof req.query.status === 'string' ? req.query.status : undefined;
      if (statusFilter) {
        tasks = tasks.filter(t => t.status === statusFilter);
      }

      const summaries = tasks.map(t => taskStore.toSummary(t));
      res.status(200).json(summaries);
    } catch (err) {
      console.error('[projects] Error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/projects/:id/tasks — create a task within a project
  router.post('/api/projects/:id/tasks', async (req: Request, res: Response) => {
    try {
      const project = projectStore.getProject(req.params.id as string);
      if (!project) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }

      const { prompt, pipeline, permissionMode, execute } = req.body ?? {};

      if (typeof prompt !== 'string' || prompt.trim() === '') {
        res.status(400).json({ error: 'prompt must be a non-empty string' });
        return;
      }
      if (prompt.length > 10_000) {
        res.status(400).json({ error: 'prompt must be at most 10000 characters' });
        return;
      }
      if (pipeline !== undefined && (!Array.isArray(pipeline) || !pipeline.every((s: unknown) => typeof s === 'string'))) {
        res.status(400).json({ error: 'pipeline must be an array of strings' });
        return;
      }

      if (execute) {
        // Create and immediately execute
        const id = await taskStore.createTask({
          prompt,
          workDir: project.path,
          projectId: project.id,
          pipeline,
          permissionMode,
        });
        const task = taskStore.getTask(id);
        res.status(201).json(task ? taskStore.toSummary(task) : { id });
      } else {
        // Create as TODO
        const id = taskStore.createTodoTask({
          projectId: project.id,
          prompt,
          workDir: project.path,
          pipeline,
          permissionMode,
        });
        const task = taskStore.getTask(id);
        res.status(201).json(task ? taskStore.toSummary(task) : { id });
      }
    } catch (err) {
      console.error('[projects] Error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
