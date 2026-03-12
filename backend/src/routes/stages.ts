import { Router } from 'express';
import type { Request, Response } from 'express';
import { BUILTIN_STAGES } from '../../../core/stageDefinitions.ts';
import type { TaskStore } from '../taskStore.ts';

/**
 * Stages router — lists available stages for a project.
 * Custom stages are loaded from dagclaw.config.ts/.json at startup.
 * Stage creation/editing should be done by modifying the config file directly
 * (e.g., as a task), not via runtime API.
 */
export function createStagesRouter(taskStore: TaskStore): Router {
  const router = Router();

  // GET /api/stages?projectPath=... — list all stages (built-in + project custom)
  router.get('/api/stages', async (req: Request, res: Response) => {
    try {
      const projectPath = req.query.projectPath as string | undefined;
      const registry = projectPath
        ? taskStore.getStageRegistry(projectPath) ?? BUILTIN_STAGES
        : BUILTIN_STAGES;

      const stages = Object.values(registry).map(s => ({
        name: s.name,
        parallel: s.parallel ?? false,
        approvalRequired: s.approvalRequired ?? false,
        hasAllowedTools: !!s.runnerConfig.allowedTools,
      }));
      res.status(200).json(stages);
    } catch (err) {
      console.error('[stages] Error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
