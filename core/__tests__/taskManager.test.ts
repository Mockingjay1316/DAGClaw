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
  TaskRegistry,
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

describe('TaskRegistry', () => {
  const makeNode = (overrides: Partial<Parameters<typeof createTaskNode>[0]> = {}) =>
    createTaskNode({
      prompt: 'test task',
      workDir: '/tmp/test',
      pipeline: ['Plan', 'Execute', 'Verify'],
      permissionMode: 'interactive' as PermissionMode,
      ...overrides,
    });

  describe('register', () => {
    it('registers a TaskNode and retrieves it by ID via getNode', () => {
      const registry = new TaskRegistry();
      const node = makeNode();

      registry.register(node);
      const retrieved = registry.getNode(node.id);

      assert.deepEqual(retrieved, node);
    });

    it('returns undefined for an unregistered ID', () => {
      const registry = new TaskRegistry();
      assert.equal(registry.getNode('nonexistent-id'), undefined);
    });
  });

  describe('addChild', () => {
    it('adds a child node and sets parentId on the child', () => {
      const registry = new TaskRegistry();
      const parent = makeNode({ prompt: 'parent' });
      const child = makeNode({ prompt: 'child' });

      registry.register(parent);
      registry.addChild(parent.id, child);

      const retrievedChild = registry.getNode(child.id);
      assert.equal(retrievedChild!.parentId, parent.id);
    });

    it('appends child ID to parent children array', () => {
      const registry = new TaskRegistry();
      const parent = makeNode({ prompt: 'parent' });
      const child1 = makeNode({ prompt: 'child1' });
      const child2 = makeNode({ prompt: 'child2' });

      registry.register(parent);
      registry.addChild(parent.id, child1);
      registry.addChild(parent.id, child2);

      const retrievedParent = registry.getNode(parent.id);
      assert.deepEqual(retrievedParent!.children, [child1.id, child2.id]);
    });
  });

  describe('getChildren', () => {
    it('returns direct child TaskNodes', () => {
      const registry = new TaskRegistry();
      const parent = makeNode({ prompt: 'parent' });
      const child1 = makeNode({ prompt: 'child1' });
      const child2 = makeNode({ prompt: 'child2' });

      registry.register(parent);
      registry.addChild(parent.id, child1);
      registry.addChild(parent.id, child2);

      const children = registry.getChildren(parent.id);
      assert.equal(children.length, 2);
      assert.equal(children[0].prompt, 'child1');
      assert.equal(children[1].prompt, 'child2');
    });

    it('returns empty array for node with no children', () => {
      const registry = new TaskRegistry();
      const node = makeNode();
      registry.register(node);

      assert.deepEqual(registry.getChildren(node.id), []);
    });
  });

  describe('getDescendants', () => {
    it('returns all descendants recursively', () => {
      const registry = new TaskRegistry();
      const root = makeNode({ prompt: 'root' });
      const child = makeNode({ prompt: 'child' });
      const grandchild = makeNode({ prompt: 'grandchild' });

      registry.register(root);
      registry.addChild(root.id, child);
      registry.addChild(child.id, grandchild);

      const descendants = registry.getDescendants(root.id);
      assert.equal(descendants.length, 2);

      const prompts = descendants.map((d) => d.prompt);
      assert.ok(prompts.includes('child'));
      assert.ok(prompts.includes('grandchild'));
    });

    it('returns empty array for leaf node', () => {
      const registry = new TaskRegistry();
      const leaf = makeNode({ prompt: 'leaf' });
      registry.register(leaf);

      assert.deepEqual(registry.getDescendants(leaf.id), []);
    });

    it('includes deeply nested descendants', () => {
      const registry = new TaskRegistry();
      const n1 = makeNode({ prompt: 'level-0' });
      const n2 = makeNode({ prompt: 'level-1' });
      const n3 = makeNode({ prompt: 'level-2' });
      const n4 = makeNode({ prompt: 'level-3' });

      registry.register(n1);
      registry.addChild(n1.id, n2);
      registry.addChild(n2.id, n3);
      registry.addChild(n3.id, n4);

      const descendants = registry.getDescendants(n1.id);
      assert.equal(descendants.length, 3);

      const prompts = descendants.map((d) => d.prompt);
      assert.ok(prompts.includes('level-1'));
      assert.ok(prompts.includes('level-2'));
      assert.ok(prompts.includes('level-3'));
    });
  });

  describe('getDepth', () => {
    it('returns 0 for root node', () => {
      const registry = new TaskRegistry();
      const root = makeNode({ prompt: 'root' });
      registry.register(root);

      assert.equal(registry.getDepth(root.id), 0);
    });

    it('returns 1 for direct child', () => {
      const registry = new TaskRegistry();
      const root = makeNode({ prompt: 'root' });
      const child = makeNode({ prompt: 'child' });

      registry.register(root);
      registry.addChild(root.id, child);

      assert.equal(registry.getDepth(child.id), 1);
    });

    it('returns 2 for grandchild', () => {
      const registry = new TaskRegistry();
      const root = makeNode({ prompt: 'root' });
      const child = makeNode({ prompt: 'child' });
      const grandchild = makeNode({ prompt: 'grandchild' });

      registry.register(root);
      registry.addChild(root.id, child);
      registry.addChild(child.id, grandchild);

      assert.equal(registry.getDepth(grandchild.id), 2);
    });
  });

  describe('checkDepthLimit', () => {
    it('returns false when adding a child would not exceed maxDepth', () => {
      const registry = new TaskRegistry();
      const root = makeNode({ prompt: 'root' });
      registry.register(root);

      // root is depth 0, child would be depth 1, maxDepth=2 => OK
      assert.equal(registry.checkDepthLimit(root.id, 2), false);
    });

    it('returns true when adding a child would exceed maxDepth', () => {
      const registry = new TaskRegistry();
      const root = makeNode({ prompt: 'root' });
      const child = makeNode({ prompt: 'child' });

      registry.register(root);
      registry.addChild(root.id, child);

      // child is depth 1, new child would be depth 2, maxDepth=2 => exceeds
      assert.equal(registry.checkDepthLimit(child.id, 2), true);
    });

    it('returns true when parent is already at maxDepth', () => {
      const registry = new TaskRegistry();
      const root = makeNode({ prompt: 'root' });
      const child = makeNode({ prompt: 'child' });
      const grandchild = makeNode({ prompt: 'grandchild' });

      registry.register(root);
      registry.addChild(root.id, child);
      registry.addChild(child.id, grandchild);

      // grandchild is depth 2, adding child would be depth 3, maxDepth=2 => exceeds
      assert.equal(registry.checkDepthLimit(grandchild.id, 2), true);
    });

    it('returns false at the boundary (child depth equals maxDepth minus 1)', () => {
      const registry = new TaskRegistry();
      const root = makeNode({ prompt: 'root' });
      const child = makeNode({ prompt: 'child' });

      registry.register(root);
      registry.addChild(root.id, child);

      // child is depth 1, new child would be depth 2, maxDepth=3 => OK
      assert.equal(registry.checkDepthLimit(child.id, 3), false);
    });
  });
});
