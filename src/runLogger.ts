/**
 * Persistent run logging to .claw/runs/.
 * Writes manifest incrementally on each subtask completion.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type {
  RunManifest,
  UsageStats,
  Plan,
  VerificationResult,
  PermissionMode,
} from './types.ts';

export interface InitRunOptions {
  prompt: string;
  pipeline: string[];
  backend: string;
  permissionMode: PermissionMode;
  gitInfo?: RunManifest['gitInfo'];
}

export interface RunSummary {
  id: string;
  prompt: string;
  status: RunManifest['status'];
  startedAt: string;
  duration: number | null;
  estimatedCost: number;
}

function generateRunId(): string {
  const now = new Date();
  const ts = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const short = crypto.randomUUID().slice(0, 8);
  return `${ts}_${short}`;
}

function emptyUsage(): RunManifest['usage'] {
  return {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    estimatedCost: 0,
    perStage: {},
    perSubtask: {},
  };
}

export class RunLogger {
  private workDir: string;

  constructor(workDir: string) {
    this.workDir = workDir;
  }

  private clawDir(): string {
    return path.join(this.workDir, '.claw');
  }

  private runsDir(): string {
    return path.join(this.clawDir(), 'runs');
  }

  private runDir(runId: string): string {
    return path.join(this.runsDir(), runId);
  }

  private manifestPath(runId: string): string {
    return path.join(this.runDir(runId), 'manifest.json');
  }

  /** Initialize a new run. Creates directory structure and initial manifest. */
  initRun(options: InitRunOptions): string {
    const runId = generateRunId();
    const dir = this.runDir(runId);
    fs.mkdirSync(path.join(dir, 'subtasks'), { recursive: true });

    const manifest: RunManifest = {
      id: runId,
      prompt: options.prompt,
      workDir: this.workDir,
      pipeline: options.pipeline,
      backend: options.backend,
      permissionMode: options.permissionMode,
      status: 'running',
      startedAt: new Date().toISOString(),
      completedAt: null,
      duration: null,
      tree: { id: runId, prompt: options.prompt, status: 'running', stages: {}, children: [] },
      usage: emptyUsage(),
      gitInfo: options.gitInfo,
    };

    this.writeManifest(runId, manifest);
    return runId;
  }

  /** Read the manifest for a given run. */
  readManifest(runId: string): RunManifest {
    const data = fs.readFileSync(this.manifestPath(runId), 'utf-8');
    return JSON.parse(data);
  }

  /** Update run status (and completedAt/duration if terminal). */
  updateManifestStatus(
    runId: string,
    status: RunManifest['status']
  ): void {
    const manifest = this.readManifest(runId);
    manifest.status = status;

    if (status === 'completed' || status === 'failed' || status === 'cancelled') {
      manifest.completedAt = new Date().toISOString();
      manifest.duration =
        new Date(manifest.completedAt).getTime() -
        new Date(manifest.startedAt).getTime();
    }

    this.writeManifest(runId, manifest);
  }

  /** Write plan output to run directory. */
  writePlan(runId: string, plan: Plan): void {
    const planPath = path.join(this.runDir(runId), 'plan.json');
    fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));
  }

  /** Append streaming output to a subtask log file. */
  appendSubtaskLog(runId: string, subtaskIndex: number, data: string): void {
    const logPath = path.join(
      this.runDir(runId), 'subtasks', `${subtaskIndex}.log`
    );
    fs.appendFileSync(logPath, data);
  }

  /** Append output to a stage log file (Plan, Verify, etc). Numbered for retries. */
  appendStageLog(runId: string, stageName: string, data: string): void {
    const dir = this.runDir(runId);
    const prefix = stageName.toLowerCase();
    const existing = fs.readdirSync(dir).filter(f => f.startsWith(prefix) && f.endsWith('.log'));
    const attempt = existing.length;
    const filename = attempt === 0 ? `${prefix}.log` : `${prefix}-${attempt}.log`;
    fs.appendFileSync(path.join(dir, filename), data);
  }

  /** Update per-subtask usage stats in the manifest. */
  updateSubtaskUsage(
    runId: string,
    subtaskIndex: number,
    usage: UsageStats
  ): void {
    const manifest = this.readManifest(runId);
    manifest.usage.perSubtask[subtaskIndex] = usage;
    this.recalcTotals(manifest);
    this.writeManifest(runId, manifest);
  }

  /** Update per-stage usage stats in the manifest. */
  updateStageUsage(
    runId: string,
    stageName: string,
    usage: UsageStats
  ): void {
    const manifest = this.readManifest(runId);
    manifest.usage.perStage[stageName] = usage;
    this.recalcTotals(manifest);
    this.writeManifest(runId, manifest);
  }

  /** Write verification result to run directory. Appends attempt number to preserve retry history. */
  writeVerification(runId: string, result: VerificationResult): void {
    const dir = this.runDir(runId);
    // Find next attempt number
    const existing = fs.readdirSync(dir).filter(f => f.startsWith('verification'));
    const attempt = existing.length;
    // Write numbered file (verification-0.json, verification-1.json, ...)
    const verifyPath = path.join(dir, `verification-${attempt}.json`);
    fs.writeFileSync(verifyPath, JSON.stringify(result, null, 2));
    // Also write latest as verification.json for easy access
    fs.writeFileSync(path.join(dir, 'verification.json'), JSON.stringify(result, null, 2));
  }

  /** Log the prompt sent to a stage/subtask invocation. */
  logStagePrompt(
    runId: string,
    stageName: string,
    prompt: string,
    systemPrompt: string,
    subtaskIndex?: number,
  ): void {
    const dir = path.join(this.runDir(runId), 'prompts');
    fs.mkdirSync(dir, { recursive: true });
    const label = subtaskIndex !== undefined
      ? `${stageName.toLowerCase()}-subtask-${subtaskIndex}`
      : stageName.toLowerCase();
    // Append attempt number if file already exists
    const existing = fs.readdirSync(dir).filter(f => f.startsWith(label));
    const attempt = existing.length;
    const filename = attempt === 0 ? `${label}.md` : `${label}-retry-${attempt}.md`;
    const content = `# ${stageName}${subtaskIndex !== undefined ? ` [Subtask ${subtaskIndex}]` : ''}${attempt > 0 ? ` (retry ${attempt})` : ''}

## System Prompt
${systemPrompt}

## Prompt
${prompt}
`;
    fs.writeFileSync(path.join(dir, filename), content);
  }

  /** List all runs, sorted by most recent first. */
  listRuns(): RunSummary[] {
    const dir = this.runsDir();
    if (!fs.existsSync(dir)) return [];

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const summaries: RunSummary[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const manifest = this.readManifest(entry.name);
        summaries.push({
          id: manifest.id,
          prompt: manifest.prompt,
          status: manifest.status,
          startedAt: manifest.startedAt,
          duration: manifest.duration,
          estimatedCost: manifest.usage.estimatedCost,
        });
      } catch {
        // skip corrupted runs
      }
    }

    summaries.sort(
      (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
    );
    return summaries;
  }

  /** Clean .claw/tmp/ directory (called before each run). */
  cleanTmp(): void {
    const tmpDir = path.join(this.clawDir(), 'tmp');
    if (fs.existsSync(tmpDir)) {
      for (const file of fs.readdirSync(tmpDir)) {
        fs.rmSync(path.join(tmpDir, file), { recursive: true, force: true });
      }
    } else {
      fs.mkdirSync(tmpDir, { recursive: true });
    }
  }

  /** Get the .claw/tmp/ path for structured output files. */
  tmpPath(filename: string): string {
    const tmpDir = path.join(this.clawDir(), 'tmp');
    fs.mkdirSync(tmpDir, { recursive: true });
    return path.join(tmpDir, filename);
  }

  private writeManifest(runId: string, manifest: RunManifest): void {
    fs.writeFileSync(
      this.manifestPath(runId),
      JSON.stringify(manifest, null, 2)
    );
  }

  private recalcTotals(manifest: RunManifest): void {
    let input = 0, output = 0, cache = 0, cost = 0;
    for (const usage of Object.values(manifest.usage.perStage)) {
      input += usage.inputTokens;
      output += usage.outputTokens;
      cache += usage.cacheReadTokens;
      cost += usage.estimatedCost;
    }
    for (const usage of Object.values(manifest.usage.perSubtask)) {
      input += usage.inputTokens;
      output += usage.outputTokens;
      cache += usage.cacheReadTokens;
      cost += usage.estimatedCost;
    }
    manifest.usage.totalInputTokens = input;
    manifest.usage.totalOutputTokens = output;
    manifest.usage.totalCacheReadTokens = cache;
    manifest.usage.estimatedCost = cost;
  }
}
