/**
 * Custom stage loading from dagclaw.config.ts / dagclaw.config.json.
 * Discovers config files in project root, validates stage definitions,
 * and merges them with BUILTIN_STAGES.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { StageDefinition, PipelineState } from './types.ts';
import { DagClawConfigSchema } from './types.ts';
import { BUILTIN_STAGES } from './stageDefinitions.ts';

// Reserved built-in stage names
const RESERVED_NAMES = new Set(['Plan', 'Execute', 'Verify']);

/**
 * Validate that an object has the minimum required StageDefinition fields.
 * For TS-sourced stages: name, runnerConfig (with systemPrompt & promptTemplate),
 * contextBuilder (function), resultHandler (function).
 * For JSON-sourced stages: contextBuilder/resultHandler can be template objects.
 * Returns { valid, errors } with all validation errors collected.
 */
export function validateStageDefinition(obj: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const o = obj as Record<string, unknown> | null;

  if (!o || typeof o !== 'object') {
    return { valid: false, errors: ['Stage definition must be an object'] };
  }

  // name
  if (!o.name || typeof o.name !== 'string') {
    errors.push('Missing or invalid "name": must be a non-empty string');
  }

  // runnerConfig
  if (!o.runnerConfig || typeof o.runnerConfig !== 'object') {
    errors.push('Missing or invalid "runnerConfig": must be an object');
  } else {
    const rc = o.runnerConfig as Record<string, unknown>;
    if (!rc.systemPrompt || typeof rc.systemPrompt !== 'string') {
      errors.push('Missing or invalid "runnerConfig.systemPrompt": must be a non-empty string');
    }
    if (!rc.promptTemplate || typeof rc.promptTemplate !== 'string') {
      errors.push('Missing or invalid "runnerConfig.promptTemplate": must be a non-empty string');
    }
  }

  // contextBuilder - function or template object
  if (o.contextBuilder === undefined || o.contextBuilder === null) {
    errors.push('Missing "contextBuilder": must be a function or template object');
  } else if (typeof o.contextBuilder !== 'function') {
    // Check if it's a valid template object
    const cb = o.contextBuilder as Record<string, unknown>;
    if (typeof cb !== 'object' || cb.type !== 'template') {
      errors.push('Invalid "contextBuilder": must be a function or { type: "template", mapping: {...} }');
    }
  }

  // resultHandler - function or template object
  if (o.resultHandler === undefined || o.resultHandler === null) {
    errors.push('Missing "resultHandler": must be a function or template object');
  } else if (typeof o.resultHandler !== 'function') {
    const rh = o.resultHandler as Record<string, unknown>;
    if (typeof rh !== 'object' || rh.type !== 'template') {
      errors.push('Invalid "resultHandler": must be a function or { type: "template", template: "..." }');
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Build a default contextBuilder for JSON-sourced stages.
 * Returns all string fields from PipelineState plus outputFile.
 */
function makeDefaultContextBuilder(): StageDefinition['contextBuilder'] {
  return (state: PipelineState, outputFile: string) => {
    const ctx: Record<string, string> = { outputFile };
    for (const [key, value] of Object.entries(state)) {
      if (typeof value === 'string') {
        ctx[key] = value;
      }
    }
    return ctx;
  };
}

/**
 * Build a default resultHandler for JSON-sourced stages.
 * Reads parsed output and returns a simple status message.
 */
function makeDefaultResultHandler(stageName: string): StageDefinition['resultHandler'] {
  return (_state: PipelineState, parsedOutput: unknown | null) => {
    if (!parsedOutput) {
      return `[${stageName}] No output received.`;
    }
    const output = parsedOutput as Record<string, unknown>;
    const summary = output.summary ?? output.message ?? 'completed';
    return `[${stageName}] ${summary}`;
  };
}

/**
 * Load custom stages from dagclaw.config.ts or dagclaw.config.json in projectDir.
 * - dagclaw.config.ts takes priority (loaded via dynamic import)
 * - dagclaw.config.json is fallback (validated with DagClawConfigSchema)
 * Returns empty record if no config file found.
 */
export async function loadCustomStages(
  projectDir: string,
): Promise<Record<string, StageDefinition>> {
  const tsPath = join(projectDir, 'dagclaw.config.ts');
  const jsonPath = join(projectDir, 'dagclaw.config.json');

  // Check for TS config first (higher priority)
  if (existsSync(tsPath)) {
    return loadFromTs(tsPath);
  }

  // Fall back to JSON config
  if (existsSync(jsonPath)) {
    return loadFromJson(jsonPath);
  }

  // No config file found
  return {};
}

/**
 * Load stages from a TypeScript config file via dynamic import.
 * Expected format: export default { stages: { StageName: StageDefinition, ... } }
 */
async function loadFromTs(tsPath: string): Promise<Record<string, StageDefinition>> {
  const fileUrl = pathToFileURL(tsPath).href;
  const mod = await import(fileUrl);
  const config = mod.default;

  if (!config || typeof config !== 'object' || !config.stages) {
    throw new Error(
      `Invalid dagclaw.config.ts: must export default { stages: { ... } }`,
    );
  }

  const stages: Record<string, StageDefinition> = {};
  for (const [key, value] of Object.entries(config.stages)) {
    const validation = validateStageDefinition(value);
    if (!validation.valid) {
      throw new Error(
        `Invalid stage "${key}" in dagclaw.config.ts:\n  - ${validation.errors.join('\n  - ')}`,
      );
    }
    stages[key] = value as StageDefinition;
  }

  return stages;
}

/**
 * Load stages from a JSON config file.
 * Validates with DagClawConfigSchema, then converts to full StageDefinitions
 * by providing default contextBuilder and resultHandler.
 */
function loadFromJson(jsonPath: string): Record<string, StageDefinition> {
  const raw = readFileSync(jsonPath, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Invalid JSON in ${jsonPath}: ${(e as Error).message}`);
  }

  // Validate with Zod schema (validates name, runnerConfig, etc.)
  const result = DagClawConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('\n  - ');
    throw new Error(`Invalid dagclaw.config.json:\n  - ${issues}`);
  }

  const config = result.data;
  const stages: Record<string, StageDefinition> = {};

  for (const [key, stageDef] of Object.entries(config.stages)) {
    stages[key] = {
      name: stageDef.name,
      runnerConfig: {
        systemPrompt: stageDef.runnerConfig.systemPrompt,
        promptTemplate: stageDef.runnerConfig.promptTemplate,
        allowedTools: stageDef.runnerConfig.allowedTools,
      },
      approvalRequired: stageDef.approvalRequired,
      parallel: stageDef.parallel,
      maxRetries: stageDef.maxRetries,
      retryStage: stageDef.retryStage,
      contextBuilder: makeDefaultContextBuilder(),
      resultHandler: makeDefaultResultHandler(stageDef.name),
    };
  }

  return stages;
}

/**
 * Merge custom stages into built-in stages.
 * Throws if a custom stage name matches a built-in name (Plan, Execute, Verify)
 * unless the custom stage has an explicit overrideBuiltin flag.
 */
export function mergeStages(
  builtins: Record<string, StageDefinition>,
  custom: Record<string, StageDefinition>,
): Record<string, StageDefinition> {
  const merged = { ...builtins };

  for (const [name, stage] of Object.entries(custom)) {
    if (name in builtins && RESERVED_NAMES.has(name)) {
      // Check for explicit override flag
      const stageWithFlag = stage as StageDefinition & { overrideBuiltin?: boolean };
      if (!stageWithFlag.overrideBuiltin) {
        throw new Error(
          `Custom stage "${name}" conflicts with built-in stage. ` +
          `"${name}" is a reserved built-in stage name. ` +
          `To override it, set overrideBuiltin: true in the stage definition.`,
        );
      }
    }
    merged[name] = stage;
  }

  return merged;
}

/**
 * Convenience function: load custom stages from projectDir and merge with BUILTIN_STAGES.
 */
export async function loadAndMergeStages(
  projectDir: string,
): Promise<Record<string, StageDefinition>> {
  const custom = await loadCustomStages(projectDir);
  return mergeStages(BUILTIN_STAGES, custom);
}
