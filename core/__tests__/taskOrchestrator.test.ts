import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateUsage,
  getFilesModifiedByGit,
  isGitRepo,
  shouldRecurse,
  buildChildOptions,
  formatTokenCount,
  formatDuration,
} from '../taskOrchestrator.ts';
import {
  formatPlanForDisplay,
  detectSharedResourceConflicts,
} from '../stageDefinitions.ts';
import { createTaskNode, TaskRegistry } from '../taskManager.ts';
import type { Plan, Subtask, UsageStats, CliOptions } from '../types.ts';

// --- formatTokenCount ---

describe('formatTokenCount', () => {
  it('formats large numbers with k suffix', () => {
    assert.equal(formatTokenCount(18200), '18.2k');
  });

  it('formats round thousands', () => {
    assert.equal(formatTokenCount(5000), '5.0k');
  });

  it('returns raw number for small values', () => {
    assert.equal(formatTokenCount(500), '500');
  });

  it('returns raw number for zero', () => {
    assert.equal(formatTokenCount(0), '0');
  });

  it('formats values just at 1000 with k suffix', () => {
    assert.equal(formatTokenCount(1000), '1.0k');
  });
});

// --- formatDuration ---

describe('formatDuration', () => {
  it('formats minutes and seconds', () => {
    assert.equal(formatDuration(204300), '3m 24s');
  });

  it('formats seconds only for short durations', () => {
    assert.equal(formatDuration(45000), '45s');
  });

  it('formats zero', () => {
    assert.equal(formatDuration(0), '0s');
  });

  it('formats exact minutes', () => {
    assert.equal(formatDuration(120000), '2m 0s');
  });

  it('rounds sub-second values', () => {
    assert.equal(formatDuration(1500), '2s');
    assert.equal(formatDuration(1400), '1s');
  });
});

// --- formatPlanForDisplay ---

describe('formatPlanForDisplay', () => {
  const plan: Plan = {
    summary: 'Build a REST API',
    subtasks: [
      {
        index: 0,
        description: 'Set up Express scaffold',
        prompt: 'Create Express app',
        dependencies: [],
        estimatedComplexity: 'low',
        needsRecursiveDecomposition: false,
      },
      {
        index: 1,
        description: 'Implement routes',
        prompt: 'Add REST routes',
        dependencies: [0],
        estimatedComplexity: 'medium',
        needsRecursiveDecomposition: false,
      },
    ],
    worthDistilling: true,
  };

  it('includes plan summary', () => {
    const display = formatPlanForDisplay(plan);
    assert.ok(display.includes('Build a REST API'));
  });

  it('includes subtask descriptions', () => {
    const display = formatPlanForDisplay(plan);
    assert.ok(display.includes('Set up Express scaffold'));
    assert.ok(display.includes('Implement routes'));
  });

  it('includes dependency info', () => {
    const display = formatPlanForDisplay(plan);
    assert.ok(display.includes('depends on: 0'));
  });

  it('includes complexity', () => {
    const display = formatPlanForDisplay(plan);
    assert.ok(display.includes('low'));
    assert.ok(display.includes('medium'));
  });

  it('shows subtask count', () => {
    const display = formatPlanForDisplay(plan);
    assert.ok(display.includes('2 subtask'));
  });

  it('shows quality flag when present', () => {
    const planWithFlag: Plan = {
      ...plan,
      qualityFlag: {
        concern: 'vague',
        message: 'Prompt lacks specificity',
        suggestion: 'Be more specific about which API endpoints',
      },
    };
    const display = formatPlanForDisplay(planWithFlag);
    assert.ok(display.includes('vague'));
    assert.ok(display.includes('Prompt lacks specificity'));
  });
});

// --- detectSharedResourceConflicts ---

describe('detectSharedResourceConflicts', () => {
  it('returns empty for no conflicts', () => {
    const subtasks = [
      { index: 0, prompt: 'Edit file A', dependencies: [] },
      { index: 1, prompt: 'Edit file B', dependencies: [] },
    ];
    const warnings = detectSharedResourceConflicts(subtasks);
    assert.equal(warnings.length, 0);
  });

  it('warns when independent subtasks both run npm install', () => {
    const subtasks = [
      { index: 0, prompt: 'Run npm install express', dependencies: [] },
      { index: 1, prompt: 'Run npm install zod', dependencies: [] },
    ];
    const warnings = detectSharedResourceConflicts(subtasks);
    assert.ok(warnings.length > 0);
    assert.ok(warnings[0].includes('npm'));
  });

  it('does not warn when npm subtasks are sequential', () => {
    const subtasks = [
      { index: 0, prompt: 'Run npm install express', dependencies: [] },
      { index: 1, prompt: 'Run npm install zod', dependencies: [0] },
    ];
    const warnings = detectSharedResourceConflicts(subtasks);
    assert.equal(warnings.length, 0);
  });

  it('detects yarn and pip conflicts', () => {
    const subtasks = [
      { index: 0, prompt: 'Run yarn add express', dependencies: [] },
      { index: 1, prompt: 'Run pip install flask', dependencies: [] },
      { index: 2, prompt: 'Run yarn add zod', dependencies: [] },
    ];
    const warnings = detectSharedResourceConflicts(subtasks);
    assert.ok(warnings.some(w => w.includes('yarn')));
  });
});

// --- aggregateUsage ---

describe('aggregateUsage', () => {
  const makeUsage = (input: number, output: number): UsageStats => ({
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    estimatedCost: 0.01,
  });

  it('sums token counts across multiple UsageStats', () => {
    const stats = [makeUsage(100, 50), makeUsage(200, 100)];
    const total = aggregateUsage(stats);
    assert.equal(total.inputTokens, 300);
    assert.equal(total.outputTokens, 150);
  });

  it('sums costs', () => {
    const stats = [makeUsage(100, 50), makeUsage(200, 100)];
    const total = aggregateUsage(stats);
    assert.equal(total.estimatedCost, 0.02);
  });

  it('returns zeros for empty array', () => {
    const total = aggregateUsage([]);
    assert.equal(total.inputTokens, 0);
    assert.equal(total.outputTokens, 0);
    assert.equal(total.estimatedCost, 0);
  });
});

// --- isGitRepo ---

describe('isGitRepo', () => {
  it('returns true for the claw_ui repo', () => {
    assert.equal(isGitRepo(process.cwd()), true);
  });

  it('returns false for /tmp', () => {
    assert.equal(isGitRepo('/tmp'), false);
  });
});

// --- getFilesModifiedByGit ---

describe('getFilesModifiedByGit', () => {
  it('returns an array of strings', () => {
    const files = getFilesModifiedByGit(process.cwd());
    assert.ok(Array.isArray(files));
    for (const f of files) assert.equal(typeof f, 'string');
  });
});

// --- shouldRecurse ---

describe('shouldRecurse', () => {
  const makePlan = (subtasks: Plan['subtasks']): Plan => ({
    summary: 'Test plan',
    subtasks,
    worthDistilling: false,
  });

  const makeSubtask = (index: number, needsRecursive: boolean): Subtask => ({
    index,
    description: `Subtask ${index}`,
    prompt: `Do subtask ${index}`,
    dependencies: [],
    estimatedComplexity: 'medium',
    needsRecursiveDecomposition: needsRecursive,
  });

  it('returns true when subtask has needsRecursiveDecomposition: true', () => {
    const plan = makePlan([makeSubtask(0, true)]);
    assert.equal(shouldRecurse(0, plan), true);
  });

  it('returns false when subtask has needsRecursiveDecomposition: false', () => {
    const plan = makePlan([makeSubtask(0, false)]);
    assert.equal(shouldRecurse(0, plan), false);
  });

  it('returns false for an out-of-bounds index', () => {
    const plan = makePlan([makeSubtask(0, true)]);
    assert.equal(shouldRecurse(5, plan), false);
  });
});

// --- buildChildOptions ---

describe('buildChildOptions', () => {
  const parentOpts: CliOptions = {
    prompt: 'Build the whole app',
    workDir: '/home/user/project',
    pipeline: ['Plan', 'Execute', 'Verify'],
    backend: { type: 'cli' },
    permissionMode: 'auto',
    autoApprove: false,
    maxRetries: 2,
    maxConcurrency: 4,
    maxDepth: 3,
    timeoutSeconds: 300,
    noSummary: false,
    noMemory: false,
    dagStages: ['Execute'],
  };

  const subtask: Subtask = {
    index: 0,
    description: 'Set up database layer',
    prompt: 'Create the database schema and ORM models',
    dependencies: [],
    estimatedComplexity: 'high',
    needsRecursiveDecomposition: true,
  };

  it('sets prompt to the subtask prompt', () => {
    const child = buildChildOptions(parentOpts, subtask, 0);
    assert.equal(child.prompt, subtask.prompt);
  });

  it('keeps the same workDir, backend, and permissionMode', () => {
    const child = buildChildOptions(parentOpts, subtask, 0);
    assert.equal(child.workDir, parentOpts.workDir);
    assert.deepEqual(child.backend, parentOpts.backend);
    assert.equal(child.permissionMode, parentOpts.permissionMode);
  });

  it('uses the same pipeline (Plan/Execute/Verify)', () => {
    const child = buildChildOptions(parentOpts, subtask, 0);
    assert.deepEqual(child.pipeline, ['Plan', 'Execute', 'Verify']);
  });

  it('sets maxDepth to parentOpts.maxDepth (unchanged)', () => {
    const child = buildChildOptions(parentOpts, subtask, 0);
    assert.equal(child.maxDepth, parentOpts.maxDepth);
  });

  it('sets autoApprove to true for child tasks', () => {
    const child = buildChildOptions(parentOpts, subtask, 0);
    assert.equal(child.autoApprove, true);
  });

  it('sets noSummary to true for child tasks', () => {
    const child = buildChildOptions(parentOpts, subtask, 0);
    assert.equal(child.noSummary, true);
  });

  it('preserves maxConcurrency, timeoutSeconds, and maxRetries', () => {
    const child = buildChildOptions(parentOpts, subtask, 0);
    assert.equal(child.maxConcurrency, parentOpts.maxConcurrency);
    assert.equal(child.timeoutSeconds, parentOpts.timeoutSeconds);
    assert.equal(child.maxRetries, parentOpts.maxRetries);
  });

  it('throws if currentDepth >= parentOpts.maxDepth', () => {
    assert.throws(
      () => buildChildOptions(parentOpts, subtask, 3),
      { message: /Max recursion depth \(3\) reached/ },
    );
    assert.throws(
      () => buildChildOptions(parentOpts, subtask, 5),
      { message: /Max recursion depth \(3\) reached/ },
    );
  });

  it('propagates dagStages from parent', () => {
    const opts = { ...parentOpts, dagStages: ['Execute', 'Lint'] };
    const child = buildChildOptions(opts, subtask, 0);
    assert.deepEqual(child.dagStages, ['Execute', 'Lint']);
  });
});

// --- resolveModel ---

import { resolveModel } from '../taskOrchestrator.ts';

describe('resolveModel', () => {
  it('returns stage model when set (highest precedence)', () => {
    assert.equal(resolveModel('stage-model', true, 'dag-model', 'global-model'), 'stage-model');
    assert.equal(resolveModel('stage-model', false, 'dag-model', 'global-model'), 'stage-model');
  });

  it('returns dagModel for parallel stages when no stage model', () => {
    assert.equal(resolveModel(undefined, true, 'dag-model', 'global-model'), 'dag-model');
  });

  it('skips dagModel for non-parallel stages, falls through to global', () => {
    assert.equal(resolveModel(undefined, false, 'dag-model', 'global-model'), 'global-model');
  });

  it('returns global model when no stage or dag model', () => {
    assert.equal(resolveModel(undefined, true, undefined, 'global-model'), 'global-model');
    assert.equal(resolveModel(undefined, false, undefined, 'global-model'), 'global-model');
  });

  it('returns undefined when nothing is set', () => {
    assert.equal(resolveModel(undefined, true, undefined, undefined), undefined);
    assert.equal(resolveModel(undefined, false, undefined, undefined), undefined);
  });
});

// --- TaskRegistry integration ---

describe('TaskRegistry integration', () => {
  it('creates a parent node and adds a child via registry', () => {
    const registry = new TaskRegistry();
    const parent = createTaskNode({
      prompt: 'Build the app',
      workDir: '/tmp/project',
      pipeline: ['Plan', 'Execute', 'Verify'],
      permissionMode: 'auto',
    });
    registry.register(parent);

    const child = createTaskNode({
      prompt: 'Set up database',
      workDir: '/tmp/project',
      pipeline: ['Plan', 'Execute', 'Verify'],
      permissionMode: 'auto',
    });
    registry.addChild(parent.id, child);

    // Child should have parentId set
    assert.equal(child.parentId, parent.id);
    // Parent should list child in children array
    assert.ok(parent.children.includes(child.id));
    // Registry should return the child
    assert.equal(registry.getNode(child.id)?.id, child.id);
  });

  it('reports correct depth for parent and child nodes', () => {
    const registry = new TaskRegistry();
    const root = createTaskNode({
      prompt: 'Root task',
      workDir: '/tmp/project',
      pipeline: ['Plan', 'Execute', 'Verify'],
      permissionMode: 'auto',
    });
    registry.register(root);

    const child = createTaskNode({
      prompt: 'Child task',
      workDir: '/tmp/project',
      pipeline: ['Plan', 'Execute', 'Verify'],
      permissionMode: 'auto',
    });
    registry.addChild(root.id, child);

    const grandchild = createTaskNode({
      prompt: 'Grandchild task',
      workDir: '/tmp/project',
      pipeline: ['Plan', 'Execute', 'Verify'],
      permissionMode: 'auto',
    });
    registry.addChild(child.id, grandchild);

    assert.equal(registry.getDepth(root.id), 0);
    assert.equal(registry.getDepth(child.id), 1);
    assert.equal(registry.getDepth(grandchild.id), 2);
  });

  it('getChildren returns direct children only', () => {
    const registry = new TaskRegistry();
    const root = createTaskNode({
      prompt: 'Root',
      workDir: '/tmp/project',
      pipeline: ['Plan', 'Execute', 'Verify'],
      permissionMode: 'auto',
    });
    registry.register(root);

    const child1 = createTaskNode({
      prompt: 'Child 1',
      workDir: '/tmp/project',
      pipeline: ['Plan', 'Execute', 'Verify'],
      permissionMode: 'auto',
    });
    const child2 = createTaskNode({
      prompt: 'Child 2',
      workDir: '/tmp/project',
      pipeline: ['Plan', 'Execute', 'Verify'],
      permissionMode: 'auto',
    });
    registry.addChild(root.id, child1);
    registry.addChild(root.id, child2);

    const grandchild = createTaskNode({
      prompt: 'Grandchild',
      workDir: '/tmp/project',
      pipeline: ['Plan', 'Execute', 'Verify'],
      permissionMode: 'auto',
    });
    registry.addChild(child1.id, grandchild);

    const children = registry.getChildren(root.id);
    assert.equal(children.length, 2);
    assert.ok(children.some(c => c.id === child1.id));
    assert.ok(children.some(c => c.id === child2.id));
    // Grandchild should NOT be in direct children
    assert.ok(!children.some(c => c.id === grandchild.id));
  });

  it('checkDepthLimit returns true when depth would exceed maxDepth', () => {
    const registry = new TaskRegistry();
    const root = createTaskNode({
      prompt: 'Root',
      workDir: '/tmp/project',
      pipeline: ['Plan', 'Execute', 'Verify'],
      permissionMode: 'auto',
    });
    registry.register(root);

    const child = createTaskNode({
      prompt: 'Child',
      workDir: '/tmp/project',
      pipeline: ['Plan', 'Execute', 'Verify'],
      permissionMode: 'auto',
    });
    registry.addChild(root.id, child);

    // root is depth 0, child is depth 1
    // Adding to child would be depth 2. maxDepth=2 → should be at limit
    assert.equal(registry.checkDepthLimit(child.id, 2), true);
    // maxDepth=3 → still room
    assert.equal(registry.checkDepthLimit(child.id, 3), false);
  });
});
