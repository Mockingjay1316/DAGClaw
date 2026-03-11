/**
 * DAG-based dependency resolver for subtask execution ordering.
 */

export interface DependencyEntry {
  index: number;
  dependencies: number[];
}

/**
 * Detects circular dependencies in a DAG.
 * Returns the cycle as an array of indices, or null if acyclic.
 */
export function detectCircularDependencies(
  entries: DependencyEntry[]
): number[] | null {
  const visited = new Set<number>();
  const inStack = new Set<number>();
  const parent = new Map<number, number>();

  const adj = new Map<number, number[]>();
  for (const entry of entries) {
    adj.set(entry.index, entry.dependencies);
  }

  function dfs(node: number): number[] | null {
    visited.add(node);
    inStack.add(node);

    for (const dep of adj.get(node) ?? []) {
      if (!visited.has(dep)) {
        parent.set(dep, node);
        const cycle = dfs(dep);
        if (cycle) return cycle;
      } else if (inStack.has(dep)) {
        // Found cycle — reconstruct it
        const cycle = [dep];
        let curr = node;
        while (curr !== dep) {
          cycle.push(curr);
          curr = parent.get(curr)!;
        }
        cycle.push(dep);
        return cycle.reverse();
      }
    }

    inStack.delete(node);
    return null;
  }

  for (const entry of entries) {
    if (!visited.has(entry.index)) {
      const cycle = dfs(entry.index);
      if (cycle) return cycle;
    }
  }

  return null;
}

/**
 * Returns all indices that transitively depend on the given index.
 */
export function getDownstreamDependents(
  index: number,
  entries: DependencyEntry[]
): number[] {
  // Build reverse adjacency: who depends on whom
  const reverseDeps = new Map<number, number[]>();
  for (const entry of entries) {
    for (const dep of entry.dependencies) {
      const existing = reverseDeps.get(dep) ?? [];
      existing.push(entry.index);
      reverseDeps.set(dep, existing);
    }
  }

  const result = new Set<number>();
  const queue = [index];

  while (queue.length > 0) {
    const current = queue.pop()!;
    for (const dependent of reverseDeps.get(current) ?? []) {
      if (!result.has(dependent)) {
        result.add(dependent);
        queue.push(dependent);
      }
    }
  }

  return Array.from(result);
}

/**
 * Returns all indices that the given index transitively depends on.
 */
export function getUpstreamAncestors(
  index: number,
  entries: DependencyEntry[]
): number[] {
  const depsMap = new Map<number, number[]>();
  for (const entry of entries) {
    depsMap.set(entry.index, entry.dependencies);
  }

  const result = new Set<number>();
  const queue = [...(depsMap.get(index) ?? [])];

  while (queue.length > 0) {
    const current = queue.pop()!;
    if (!result.has(current)) {
      result.add(current);
      for (const dep of depsMap.get(current) ?? []) {
        queue.push(dep);
      }
    }
  }

  return Array.from(result);
}

type SubtaskState = 'pending' | 'complete' | 'skipped';

/**
 * Tracks DAG state and yields ready-to-run subtask indices.
 */
export class DependencyResolver {
  private states: Map<number, SubtaskState>;
  private deps: Map<number, number[]>;
  private entries: DependencyEntry[];

  constructor(entries: DependencyEntry[]) {
    this.entries = entries;
    this.states = new Map();
    this.deps = new Map();

    for (const entry of entries) {
      this.states.set(entry.index, 'pending');
      this.deps.set(entry.index, [...entry.dependencies]);
    }
  }

  /** Returns indices of subtasks whose dependencies are all complete. */
  getReady(): number[] {
    const ready: number[] = [];
    for (const [index, state] of this.states) {
      if (state !== 'pending') continue;
      const deps = this.deps.get(index)!;
      const allDepsComplete = deps.every(
        (d) => this.states.get(d) === 'complete'
      );
      if (allDepsComplete) {
        ready.push(index);
      }
    }
    return ready;
  }

  /** Marks a subtask as complete. */
  markComplete(index: number): void {
    this.assertExists(index);
    if (this.states.get(index) === 'complete') {
      throw new Error(`Subtask ${index} is already completed`);
    }
    this.states.set(index, 'complete');
  }

  /** Marks a subtask as skipped and cascades to all downstream dependents. Returns cascaded indices. */
  markSkipped(index: number): number[] {
    this.assertExists(index);
    this.states.set(index, 'skipped');

    const downstream = getDownstreamDependents(index, this.entries);
    for (const dep of downstream) {
      this.states.set(dep, 'skipped');
    }
    return downstream;
  }

  /** Checks if a subtask is skipped. */
  isSkipped(index: number): boolean {
    return this.states.get(index) === 'skipped';
  }

  /** Returns true if all subtasks are complete or skipped. */
  allComplete(): boolean {
    for (const state of this.states.values()) {
      if (state === 'pending') return false;
    }
    return true;
  }

  private assertExists(index: number): void {
    if (!this.states.has(index)) {
      throw new Error(`Unknown subtask index: ${index}`);
    }
  }
}
