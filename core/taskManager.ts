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
  return path.join(workDir, '.dagclaw', 'lock');
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Acquire a lockfile atomically. Throws if another claw instance is running in this workdir. */
export function acquireLock(workDir: string, runId: string): void {
  const lp = lockPath(workDir);
  fs.mkdirSync(path.dirname(lp), { recursive: true });

  const info: LockInfo = {
    pid: process.pid,
    runId,
    startedAt: new Date().toISOString(),
  };
  const data = JSON.stringify(info, null, 2);

  try {
    // Atomic create — fails if file already exists (no TOCTOU race)
    fs.writeFileSync(lp, data, { flag: 'wx' });
  } catch (err: any) {
    if (err?.code !== 'EEXIST') throw err;

    // Lock file exists — check if the holder is still alive
    let existing: LockInfo;
    try {
      existing = JSON.parse(fs.readFileSync(lp, 'utf-8'));
    } catch {
      // Corrupted lock — remove and retry
      fs.unlinkSync(lp);
      fs.writeFileSync(lp, data, { flag: 'wx' });
      return;
    }

    if (isProcessAlive(existing.pid)) {
      throw new Error(
        `Another claw instance is already running in ${workDir} (PID ${existing.pid}, run ${existing.runId})`
      );
    }

    // Stale lock — remove and re-acquire atomically
    fs.unlinkSync(lp);
    try {
      fs.writeFileSync(lp, data, { flag: 'wx' });
    } catch (retryErr: any) {
      // Another process grabbed it between unlink and write
      if (retryErr?.code === 'EEXIST') {
        throw new Error(`Another claw instance acquired the lock in ${workDir} during stale lock cleanup`);
      }
      throw retryErr;
    }
  }
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

// --- Task Registry ---

/** Manages TaskNode instances and their parent/child relationships. */
export class TaskRegistry {
  private nodes: Map<string, TaskNode> = new Map();

  /** Store a node by its ID. */
  register(node: TaskNode): void {
    this.nodes.set(node.id, node);
  }

  /** Retrieve a node by ID, or undefined if not found. */
  getNode(id: string): TaskNode | undefined {
    return this.nodes.get(id);
  }

  /** Set childNode.parentId, push childNode.id to parent.children, and register child. */
  addChild(parentId: string, childNode: TaskNode): void {
    const parent = this.requireNode(parentId);
    childNode.parentId = parentId;
    parent.children.push(childNode.id);
    this.register(childNode);
  }

  /** Return direct child TaskNodes. */
  getChildren(nodeId: string): TaskNode[] {
    const node = this.requireNode(nodeId);
    return node.children.map((cid) => this.requireNode(cid));
  }

  /** Return all descendants via BFS. */
  getDescendants(nodeId: string): TaskNode[] {
    const result: TaskNode[] = [];
    const queue = [...this.requireNode(nodeId).children];
    while (queue.length > 0) {
      const cid = queue.shift()!;
      const child = this.requireNode(cid);
      result.push(child);
      queue.push(...child.children);
    }
    return result;
  }

  /** Return depth of a node (root = 0, walks parentId chain). */
  getDepth(nodeId: string): number {
    let depth = 0;
    let current = this.requireNode(nodeId);
    while (current.parentId !== null) {
      depth++;
      current = this.requireNode(current.parentId);
    }
    return depth;
  }

  /** Return true if adding a child to parentId would exceed maxDepth. */
  checkDepthLimit(parentId: string, maxDepth: number): boolean {
    return this.getDepth(parentId) + 1 >= maxDepth;
  }

  private requireNode(id: string): TaskNode {
    const node = this.nodes.get(id);
    if (!node) {
      throw new Error(`TaskRegistry: unknown node ID "${id}"`);
    }
    return node;
  }
}
