import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DependencyResolver,
  detectCircularDependencies,
  getDownstreamDependents,
} from '../dependencyResolver.ts';

describe('DependencyResolver', () => {
  describe('linear chain: 0 -> 1 -> 2', () => {
    it('returns tasks in order', () => {
      const resolver = new DependencyResolver([
        { index: 0, dependencies: [] },
        { index: 1, dependencies: [0] },
        { index: 2, dependencies: [1] },
      ]);

      assert.deepEqual(resolver.getReady(), [0]);
      assert.equal(resolver.allComplete(), false);

      resolver.markComplete(0);
      assert.deepEqual(resolver.getReady(), [1]);

      resolver.markComplete(1);
      assert.deepEqual(resolver.getReady(), [2]);

      resolver.markComplete(2);
      assert.equal(resolver.allComplete(), true);
    });
  });

  describe('independent tasks: 0, 1, 2 (no deps)', () => {
    it('returns all tasks immediately', () => {
      const resolver = new DependencyResolver([
        { index: 0, dependencies: [] },
        { index: 1, dependencies: [] },
        { index: 2, dependencies: [] },
      ]);

      const ready = resolver.getReady();
      assert.deepEqual(ready.sort(), [0, 1, 2]);
    });
  });

  describe('diamond: 0 -> 1, 0 -> 2, 1+2 -> 3', () => {
    it('respects diamond dependencies', () => {
      const resolver = new DependencyResolver([
        { index: 0, dependencies: [] },
        { index: 1, dependencies: [0] },
        { index: 2, dependencies: [0] },
        { index: 3, dependencies: [1, 2] },
      ]);

      assert.deepEqual(resolver.getReady(), [0]);

      resolver.markComplete(0);
      assert.deepEqual(resolver.getReady().sort(), [1, 2]);

      resolver.markComplete(1);
      // 2 is still ready (dep 0 complete), 3 still waiting on 2
      assert.deepEqual(resolver.getReady(), [2]);

      resolver.markComplete(2);
      assert.deepEqual(resolver.getReady(), [3]);

      resolver.markComplete(3);
      assert.equal(resolver.allComplete(), true);
    });
  });

  describe('empty DAG', () => {
    it('is immediately complete', () => {
      const resolver = new DependencyResolver([]);
      assert.equal(resolver.allComplete(), true);
      assert.deepEqual(resolver.getReady(), []);
    });
  });

  describe('single task', () => {
    it('returns the one task', () => {
      const resolver = new DependencyResolver([
        { index: 0, dependencies: [] },
      ]);

      assert.deepEqual(resolver.getReady(), [0]);
      resolver.markComplete(0);
      assert.equal(resolver.allComplete(), true);
    });
  });

  describe('markComplete on unknown index', () => {
    it('throws an error', () => {
      const resolver = new DependencyResolver([
        { index: 0, dependencies: [] },
      ]);

      assert.throws(() => resolver.markComplete(99), /Unknown subtask index: 99/);
    });
  });

  describe('markComplete on already completed', () => {
    it('throws an error', () => {
      const resolver = new DependencyResolver([
        { index: 0, dependencies: [] },
      ]);

      resolver.markComplete(0);
      assert.throws(() => resolver.markComplete(0), /already completed/);
    });
  });

  describe('markSkipped cascades to dependents', () => {
    it('skips downstream tasks and returns cascaded indices', () => {
      const resolver = new DependencyResolver([
        { index: 0, dependencies: [] },
        { index: 1, dependencies: [0] },
        { index: 2, dependencies: [1] },
        { index: 3, dependencies: [] },
      ]);

      resolver.markComplete(0);
      const cascaded = resolver.markSkipped(1);

      // 2 depends on 1 (skipped) so it should also be skipped
      assert.equal(resolver.isSkipped(1), true);
      assert.equal(resolver.isSkipped(2), true);
      assert.deepEqual(cascaded.sort(), [2]);

      // 3 is independent, still ready
      assert.deepEqual(resolver.getReady(), [3]);
    });
  });

  describe('markSkipped cascades through diamond', () => {
    it('skips transitively through diamond and returns cascaded indices', () => {
      const resolver = new DependencyResolver([
        { index: 0, dependencies: [] },
        { index: 1, dependencies: [0] },
        { index: 2, dependencies: [0] },
        { index: 3, dependencies: [1, 2] },
      ]);

      resolver.markComplete(0);
      const cascaded = resolver.markSkipped(1);

      // 3 depends on 1 (skipped), so 3 is skipped
      assert.equal(resolver.isSkipped(3), true);
      assert.deepEqual(cascaded.sort(), [3]);
      // 2 is independent of 1, still ready
      assert.equal(resolver.isSkipped(2), false);
      assert.deepEqual(resolver.getReady(), [2]);
    });
  });

  describe('markSkipped returns empty array for leaf node', () => {
    it('returns empty when no downstream dependents', () => {
      const resolver = new DependencyResolver([
        { index: 0, dependencies: [] },
        { index: 1, dependencies: [0] },
      ]);

      resolver.markComplete(0);
      const cascaded = resolver.markSkipped(1);
      assert.deepEqual(cascaded, []);
    });
  });

  describe('getReady excludes skipped tasks', () => {
    it('does not return skipped tasks', () => {
      const resolver = new DependencyResolver([
        { index: 0, dependencies: [] },
        { index: 1, dependencies: [] },
      ]);

      resolver.markSkipped(0);
      assert.deepEqual(resolver.getReady(), [1]);
    });
  });
});

describe('detectCircularDependencies', () => {
  it('returns null for acyclic graph', () => {
    const result = detectCircularDependencies([
      { index: 0, dependencies: [] },
      { index: 1, dependencies: [0] },
      { index: 2, dependencies: [0, 1] },
    ]);
    assert.equal(result, null);
  });

  it('detects simple cycle: 0 -> 1 -> 0', () => {
    const result = detectCircularDependencies([
      { index: 0, dependencies: [1] },
      { index: 1, dependencies: [0] },
    ]);
    assert.notEqual(result, null);
    assert.ok(result!.length >= 2);
  });

  it('detects longer cycle: 0 -> 1 -> 2 -> 0', () => {
    const result = detectCircularDependencies([
      { index: 0, dependencies: [2] },
      { index: 1, dependencies: [0] },
      { index: 2, dependencies: [1] },
    ]);
    assert.notEqual(result, null);
  });

  it('detects self-cycle: 0 -> 0', () => {
    const result = detectCircularDependencies([
      { index: 0, dependencies: [0] },
    ]);
    assert.notEqual(result, null);
  });

  it('returns null for empty graph', () => {
    const result = detectCircularDependencies([]);
    assert.equal(result, null);
  });
});

describe('getDownstreamDependents', () => {
  it('returns all transitive dependents', () => {
    const deps = getDownstreamDependents(1, [
      { index: 0, dependencies: [] },
      { index: 1, dependencies: [0] },
      { index: 2, dependencies: [1] },
      { index: 3, dependencies: [2] },
      { index: 4, dependencies: [] },
    ]);
    assert.deepEqual(deps.sort(), [2, 3]);
  });

  it('returns empty for leaf node', () => {
    const deps = getDownstreamDependents(2, [
      { index: 0, dependencies: [] },
      { index: 1, dependencies: [0] },
      { index: 2, dependencies: [1] },
    ]);
    assert.deepEqual(deps, []);
  });

  it('handles diamond correctly', () => {
    const deps = getDownstreamDependents(0, [
      { index: 0, dependencies: [] },
      { index: 1, dependencies: [0] },
      { index: 2, dependencies: [0] },
      { index: 3, dependencies: [1, 2] },
    ]);
    assert.deepEqual(deps.sort(), [1, 2, 3]);
  });
});
