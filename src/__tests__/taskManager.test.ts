import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  acquireLock,
  releaseLock,
  checkStaleLock,
  createTaskNode,
  ensureWorkDir,
} from '../taskManager.ts';
import type { PermissionMode } from '../types.ts';

let tmpDir: string;

describe('taskManager', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-tm-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('acquireLock', () => {
    it('creates .claw/lock file with PID', () => {
      acquireLock(tmpDir, 'run-123');

      const lockPath = path.join(tmpDir, '.claw', 'lock');
      assert.ok(fs.existsSync(lockPath));
      const content = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
      assert.equal(content.pid, process.pid);
      assert.equal(content.runId, 'run-123');
    });

    it('throws if lock already held', () => {
      acquireLock(tmpDir, 'run-1');
      assert.throws(() => acquireLock(tmpDir, 'run-2'), /already running/);
    });
  });

  describe('releaseLock', () => {
    it('removes lock file', () => {
      acquireLock(tmpDir, 'run-1');
      releaseLock(tmpDir);

      const lockPath = path.join(tmpDir, '.claw', 'lock');
      assert.ok(!fs.existsSync(lockPath));
    });

    it('does nothing if no lock', () => {
      // should not throw
      releaseLock(tmpDir);
    });
  });

  describe('checkStaleLock', () => {
    it('returns null when no lock file', () => {
      const result = checkStaleLock(tmpDir);
      assert.equal(result, null);
    });

    it('returns null when lock is held by current process', () => {
      acquireLock(tmpDir, 'run-1');
      const result = checkStaleLock(tmpDir);
      assert.equal(result, null);
      releaseLock(tmpDir);
    });

    it('detects and cleans stale lock (dead PID)', () => {
      // Write a lock with a PID that doesn't exist
      const lockPath = path.join(tmpDir, '.claw', 'lock');
      fs.mkdirSync(path.join(tmpDir, '.claw'), { recursive: true });
      fs.writeFileSync(
        lockPath,
        JSON.stringify({ pid: 999999999, runId: 'stale-run', startedAt: new Date().toISOString() })
      );

      const result = checkStaleLock(tmpDir);
      assert.ok(result !== null);
      assert.equal(result!.runId, 'stale-run');
      // Lock should be cleaned up
      assert.ok(!fs.existsSync(lockPath));
    });
  });

  describe('createTaskNode', () => {
    it('creates a TaskNode with correct defaults', () => {
      const node = createTaskNode({
        prompt: 'test task',
        workDir: '/tmp/test',
        pipeline: ['Plan', 'Execute', 'Verify'],
        permissionMode: 'interactive' as PermissionMode,
      });

      assert.equal(node.prompt, 'test task');
      assert.equal(node.workDir, '/tmp/test');
      assert.deepEqual(node.stagePipeline, ['Plan', 'Execute', 'Verify']);
      assert.equal(node.status, 'pending');
      assert.equal(node.currentStageIndex, -1);
      assert.equal(node.parentId, null);
      assert.equal(node.plan, null);
      assert.deepEqual(node.children, []);
      assert.equal(node.autoApprove, false);
      assert.equal(node.maxRetries, 2);
      assert.ok(node.id.length > 0);
    });

    it('allows overriding defaults', () => {
      const node = createTaskNode({
        prompt: 'test',
        workDir: '/tmp',
        pipeline: ['Plan'],
        permissionMode: 'auto',
        autoApprove: true,
        maxRetries: 5,
        parentId: 'parent-1',
      });

      assert.equal(node.autoApprove, true);
      assert.equal(node.maxRetries, 5);
      assert.equal(node.parentId, 'parent-1');
      assert.equal(node.permissionMode, 'auto');
    });
  });

  describe('ensureWorkDir', () => {
    it('creates directory if it does not exist', () => {
      const newDir = path.join(tmpDir, 'nested', 'dir');
      ensureWorkDir(newDir);
      assert.ok(fs.existsSync(newDir));
    });

    it('does nothing if directory exists', () => {
      ensureWorkDir(tmpDir);
      assert.ok(fs.existsSync(tmpDir));
    });
  });
});
