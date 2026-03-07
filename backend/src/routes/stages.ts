import { Router } from 'express';
import type { Request, Response } from 'express';
import { validateStageDefinition, mergeStages } from '../../../core/configLoader.ts';
import { BUILTIN_STAGES } from '../../../core/stageDefinitions.ts';
import type { StageDefinition } from '../../../core/types.ts';

const BUILTIN_NAMES = new Set(['Plan', 'Execute', 'Verify']);
const MAX_CUSTOM_STAGES = 50;

export function createStagesRouter(customStages: Record<string, StageDefinition>): Router {
  const router = Router();

  // GET /api/stages — list all stages (built-in + custom)
  router.get('/api/stages', async (_req: Request, res: Response) => {
    try {
      const merged = mergeStages(BUILTIN_STAGES, customStages);
      const stages = Object.values(merged).map(s => ({
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

  // POST /api/stages — create a custom stage
  router.post('/api/stages', async (req: Request, res: Response) => {
    try {
      const stage = req.body;
      const validation = validateStageDefinition(stage);
      if (!validation.valid) {
        res.status(400).json({ errors: validation.errors });
        return;
      }
      const name = (stage as { name: string }).name;
      if (BUILTIN_NAMES.has(name)) {
        res.status(409).json({ error: `Cannot override built-in stage "${name}"` });
        return;
      }
      if (!(name in customStages) && Object.keys(customStages).length >= MAX_CUSTOM_STAGES) {
        res.status(400).json({ error: `Maximum of ${MAX_CUSTOM_STAGES} custom stages reached` });
        return;
      }
      customStages[name] = stage as StageDefinition;
      res.status(201).json({ name });
    } catch (err) {
      console.error('[stages] Error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // PUT /api/stages/:name — update a custom stage
  router.put('/api/stages/:name', async (req: Request, res: Response) => {
    try {
      const name = req.params.name as string;
      if (BUILTIN_NAMES.has(name)) {
        res.status(409).json({ error: `Cannot override built-in stage "${name}"` });
        return;
      }
      if (!(name in customStages)) {
        res.status(404).json({ error: `Custom stage "${name}" not found` });
        return;
      }
      const stage = req.body;
      const validation = validateStageDefinition(stage);
      if (!validation.valid) {
        res.status(400).json({ errors: validation.errors });
        return;
      }
      customStages[name] = stage as StageDefinition;
      res.status(200).json({ name });
    } catch (err) {
      console.error('[stages] Error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // DELETE /api/stages/:name — delete a custom stage
  router.delete('/api/stages/:name', async (req: Request, res: Response) => {
    try {
      const name = req.params.name as string;
      if (BUILTIN_NAMES.has(name)) {
        res.status(409).json({ error: 'Cannot delete built-in stage' });
        return;
      }
      if (!(name in customStages)) {
        res.status(404).json({ error: `Custom stage "${name}" not found` });
        return;
      }
      delete customStages[name];
      res.status(200).json({ deleted: true });
    } catch (err) {
      console.error('[stages] Error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
