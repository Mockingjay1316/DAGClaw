/**
 * Minimal task node creation/tracking, lockfile management, orphaned run detection.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { TaskNode, PermissionMode } from './types.ts';

// --- Lockfile ---

interface LockInfo {
  pid: number;
  runId: string;
  startedAt: string;
}

function lockPath(workDir: string): string {
  return path.join(workDir, '.claw', 'lock');
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Acquire a lockfile. Throws if another claw instance is running in this workdir. */
export function acquireLock(workDir: string, runId: string): void {
  const lp = lockPath(workDir);
  fs.mkdirSync(path.dirname(lp), { recursive: true });

  if (fs.existsSync(lp)) {
    const existing: LockInfo = JSON.parse(fs.readFileSync(lp, 'utf-8'));
    if (isProcessAlive(existing.pid)) {
      throw new Error(
        `Another claw instance is already running in ${workDir} (PID ${existing.pid}, run ${existing.runId})`
      );
    }
    // Stale lock — will be overwritten
  }

  const info: LockInfo = {
    pid: process.pid,
    runId,
    startedAt: new Date().toISOString(),
  };
  fs.writeFileSync(lp, JSON.stringify(info, null, 2));
}

/** Release the lockfile. Safe to call even if no lock exists. */
export function releaseLock(workDir: string): void {
  const lp = lockPath(workDir);
  if (fs.existsSync(lp)) {
    fs.unlinkSync(lp);
  }
}

/** Check for stale lockfile. Returns stale run info if found (and cleans up). */
export function checkStaleLock(
  workDir: string
): { runId: string; pid: number } | null {
  const lp = lockPath(workDir);
  if (!fs.existsSync(lp)) return null;

  try {
    const info: LockInfo = JSON.parse(fs.readFileSync(lp, 'utf-8'));
    if (isProcessAlive(info.pid)) return null;

    // Stale — clean up
    fs.unlinkSync(lp);
    return { runId: info.runId, pid: info.pid };
  } catch {
    // Corrupted lock file — clean up
    fs.unlinkSync(lp);
    return null;
  }
}

// --- Task Node ---

export interface CreateTaskOptions {
  prompt: string;
  workDir: string;
  pipeline: string[];
  permissionMode: PermissionMode;
  autoApprove?: boolean;
  maxRetries?: number;
  parentId?: string;
}

/** Create a new TaskNode with sensible defaults. */
export function createTaskNode(options: CreateTaskOptions): TaskNode {
  return {
    id: crypto.randomUUID(),
    parentId: options.parentId ?? null,
    prompt: options.prompt,
    workDir: options.workDir,
    stagePipeline: options.pipeline,
    currentStageIndex: -1,
    status: 'pending',
    stages: {},
    plan: null,
    children: [],
    autoApprove: options.autoApprove ?? false,
    maxRetries: options.maxRetries ?? 2,
    permissionMode: options.permissionMode,
  };
}

// --- Workdir ---

/** Ensure workdir exists, creating it (with parents) if needed. */
export function ensureWorkDir(workDir: string): void {
  fs.mkdirSync(workDir, { recursive: true });
}
