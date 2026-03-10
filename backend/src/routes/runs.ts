import { Router } from 'express';
import type { Request, Response } from 'express';
import { RunLogger } from '../../../core/runLogger.ts';
import { createRateLimiter } from '../middleware/rateLimit.ts';

export function createRunsRouter(workDir: string): Router {
  const router = Router();
  const rateMax = parseInt(process.env.CLAW_RATE_LIMIT_MAX || '10', 10);
  const runsLimiter = createRateLimiter({ windowMs: 60_000, max: rateMax });

  // GET /api/runs — list run summaries
  router.get('/api/runs', runsLimiter, async (req: Request, res: Response) => {
    try {
      const logger = new RunLogger(workDir);
      let runs = logger.listRuns();

      // Optional status filter
      const status = req.query.status as string | undefined;
      if (status) {
        runs = runs.filter(r => r.status === status);
      }

      // Optional limit
      const limitParam = req.query.limit as string | undefined;
      if (limitParam) {
        const limit = parseInt(limitParam, 10);
        if (!isNaN(limit) && limit > 0) {
          runs = runs.slice(0, limit);
        }
      }

      res.status(200).json(runs);
    } catch (err) {
      console.error('[runs] Error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/runs/:id — get full run manifest
  router.get('/api/runs/:id', runsLimiter, async (req: Request, res: Response) => {
    try {
      const logger = new RunLogger(workDir);
      let manifest;
      try {
        manifest = logger.readManifest(req.params.id as string);
      } catch (readErr: unknown) {
        res.status(404).json({ error: 'Run not found' });
        return;
      }
      res.status(200).json(manifest);
    } catch (err) {
      console.error('[runs] Error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
