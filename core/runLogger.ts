/**
 * Persistent run logging to .dagclaw/runs/.
 * Writes manifest incrementally on each subtask completion.
 */

import fs, { appendFileSync, existsSync, readFileSync } from 'node:fs';
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
  taskNumber?: number;
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
  private parentRunDir?: string;
  private currentRunId?: string;

  constructor(workDir: string, parentRunDir?: string) {
    this.workDir = workDir;
    this.parentRunDir = parentRunDir;
  }

  private clawDir(): string {
    return path.join(this.workDir, '.dagclaw');
  }

  private runsDir(): string {
    return path.join(this.clawDir(), 'runs');
  }

  private runDir(runId: string): string {
    if (this.parentRunDir) {
      return path.join(this.parentRunDir, 'children', runId);
    }
    return path.join(this.runsDir(), runId);
  }

  /** Create a child RunLogger whose runs nest under the given parent run directory. */
  createChildLogger(parentRunId: string): RunLogger {
    return new RunLogger(this.workDir, this.runDir(parentRunId));
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
      taskNumber: options.taskNumber,
      usage: emptyUsage(),
      gitInfo: options.gitInfo,
    };

    this.writeManifest(runId, manifest);
    this.currentRunId = runId;
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

  /** Read plan from run directory. Returns null if not found. */
  readPlan(runId: string): Plan | null {
    const planPath = path.join(this.runDir(runId), 'plan.json');
    try {
      const data = fs.readFileSync(planPath, 'utf-8');
      return JSON.parse(data) as Plan;
    } catch {
      return null;
    }
  }

  /** Read latest verification result from run directory. Returns null if not found. */
  readVerification(runId: string): VerificationResult | null {
    const verifyPath = path.join(this.runDir(runId), 'verification.json');
    try {
      const data = fs.readFileSync(verifyPath, 'utf-8');
      return JSON.parse(data) as VerificationResult;
    } catch {
      return null;
    }
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

  /** Append a timeline event to the run's events.jsonl file. */
  appendEvent(runId: string, event: { type: string; [key: string]: unknown }): void {
    const eventsPath = path.join(this.runDir(runId), 'events.jsonl');
    const line = JSON.stringify({ ...event, timestamp: Date.now() }) + '\n';
    appendFileSync(eventsPath, line);
  }

  /** Read all persisted timeline events for a run. */
  readEvents(runId: string): Array<{ timestamp: number; type: string; [key: string]: unknown }> {
    const eventsPath = path.join(this.runDir(runId), 'events.jsonl');
    if (!existsSync(eventsPath)) return [];
    const lines = readFileSync(eventsPath, 'utf-8').trim().split('\n').filter(Boolean);
    return lines.map(line => JSON.parse(line));
  }

  /** Write a memory.md file into the run directory. */
  writeRunMemory(runId: string, content: string): void {
    const memPath = path.join(this.runDir(runId), 'memory.md');
    fs.writeFileSync(memPath, content);
  }

  /** Clean the run-scoped tmp directory (called after initRun). */
  cleanTmp(): void {
    const tmpDir = this.tmpDir();
    if (fs.existsSync(tmpDir)) {
      for (const file of fs.readdirSync(tmpDir)) {
        fs.rmSync(path.join(tmpDir, file), { recursive: true, force: true });
      }
    } else {
      fs.mkdirSync(tmpDir, { recursive: true });
    }
  }

  /** Get a run-scoped tmp path for structured output files. */
  tmpPath(filename: string): string {
    const tmpDir = this.tmpDir();
    fs.mkdirSync(tmpDir, { recursive: true });
    return path.join(tmpDir, filename);
  }

  private tmpDir(): string {
    if (this.currentRunId) {
      return path.join(this.runDir(this.currentRunId), 'tmp');
    }
    return path.join(this.clawDir(), 'tmp');
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
