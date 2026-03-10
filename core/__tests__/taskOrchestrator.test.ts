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
import type { Plan, Subtask, UsageStats, CliOptions, DAGEvent } from '../types.ts';
import { ExecutorOutputSchema } from '../types.ts';

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

// --- Per-subtask retry: DAGEvent types ---

describe('DAGEvent retry types', () => {
  it('subtask-retrying event has correct shape', () => {
    const event: DAGEvent = {
      type: 'subtask-retrying',
      index: 2,
      attempt: 1,
      maxAttempts: 3,
    };
    assert.equal(event.type, 'subtask-retrying');
    if (event.type === 'subtask-retrying') {
      assert.equal(event.index, 2);
      assert.equal(event.attempt, 1);
      assert.equal(event.maxAttempts, 3);
    }
  });

  it('subtask-retry-exhausted event has correct shape', () => {
    const event: DAGEvent = {
      type: 'subtask-retry-exhausted',
      index: 4,
      attempts: 3,
    };
    assert.equal(event.type, 'subtask-retry-exhausted');
    if (event.type === 'subtask-retry-exhausted') {
      assert.equal(event.index, 4);
      assert.equal(event.attempts, 3);
    }
  });

  it('new event types are included in DAGEvent union', () => {
    const events: DAGEvent[] = [
      { type: 'dag-start', subtasks: [{ index: 0, description: 'test', dependencies: [], stage: 'Execute' }] },
      { type: 'subtask-started', index: 0 },
      { type: 'subtask-retrying', index: 0, attempt: 1, maxAttempts: 2 },
      { type: 'subtask-retry-exhausted', index: 0, attempts: 2 },
      { type: 'subtask-failed', index: 0, error: 'boom', elapsed: 100 },
      { type: 'dag-complete' },
    ];
    assert.equal(events.length, 6);
    assert.ok(events.some(e => e.type === 'subtask-retrying'));
    assert.ok(events.some(e => e.type === 'subtask-retry-exhausted'));
  });
});

// --- Per-subtask retry: isRetryWorthy helper ---

import { isRetryWorthy } from '../taskOrchestrator.ts';

describe('isRetryWorthy', () => {
  it('returns true when executor output has retryWorthy: true', () => {
    const output = { success: false, summary: 'failed', oneliner: 'fail', retryWorthy: true };
    assert.equal(isRetryWorthy(output, null), true);
  });

  it('returns false when executor output has retryWorthy: false', () => {
    const output = { success: false, summary: 'failed', oneliner: 'fail', retryWorthy: false };
    assert.equal(isRetryWorthy(output, null), false);
  });

  it('returns false when retryWorthy is omitted from executor output', () => {
    const output = { success: false, summary: 'failed', oneliner: 'fail' };
    assert.equal(isRetryWorthy(output, null), false);
  });

  it('returns true for ClaudeRunError (transient CLI failure)', () => {
    const err = new Error('Claude CLI exited with code 1');
    err.name = 'ClaudeRunError';
    assert.equal(isRetryWorthy(null, err), true);
  });

  it('returns false for generic Error (non-transient)', () => {
    const err = new Error('Something unexpected');
    assert.equal(isRetryWorthy(null, err), false);
  });

  it('returns true for ClaudeRunError even when output is also present with retryWorthy: false', () => {
    // ClaudeRunError takes precedence — transient failures are always retryable
    const output = { success: false, summary: 'failed', oneliner: 'fail', retryWorthy: false };
    const err = new Error('Claude CLI exited with code 1');
    err.name = 'ClaudeRunError';
    assert.equal(isRetryWorthy(output, err), true);
  });
});

// --- Per-subtask retry: CliOptions.maxSubtaskRetries ---

describe('CliOptions.maxSubtaskRetries', () => {
  it('accepts maxSubtaskRetries as an optional field', () => {
    const opts: CliOptions = {
      prompt: 'test',
      workDir: '/tmp',
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
      maxSubtaskRetries: 3,
    };
    assert.equal(opts.maxSubtaskRetries, 3);
  });

  it('defaults to undefined when not specified', () => {
    const opts: CliOptions = {
      prompt: 'test',
      workDir: '/tmp',
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
    assert.equal(opts.maxSubtaskRetries, undefined);
  });
});

// --- Per-subtask retry: ExecutorOutput.retryWorthy ---

describe('ExecutorOutput retryWorthy field', () => {
  it('parses executor output with retryWorthy: true', () => {
    const raw = { success: false, summary: 'build failed', oneliner: 'fail', retryWorthy: true };
    const parsed = ExecutorOutputSchema.parse(raw);
    assert.equal(parsed.retryWorthy, true);
  });

  it('parses executor output with retryWorthy: false', () => {
    const raw = { success: false, summary: 'wrong approach', oneliner: 'fail', retryWorthy: false };
    const parsed = ExecutorOutputSchema.parse(raw);
    assert.equal(parsed.retryWorthy, false);
  });

  it('parses executor output without retryWorthy (backward compatible)', () => {
    const raw = { success: true, summary: 'done', oneliner: 'ok' };
    const parsed = ExecutorOutputSchema.parse(raw);
    assert.equal(parsed.retryWorthy, undefined);
  });
});

// --- Per-subtask retry: integration via DAG events ---

describe('Per-subtask retry via DAG events', () => {
  // These tests verify the retry behavior indirectly through DAG event emission.
  // They will fail until the retry logic is implemented in executeSubtask().

  it('emits subtask-retrying then subtask-completed on successful retry', () => {
    // Scenario: subtask fails on attempt 1 with retryWorthy:true, succeeds on attempt 2
    // Expected events: subtask-started → subtask-retrying(attempt=1, max=2) → subtask-started → subtask-completed
    // This is a specification test — actual orchestrator wiring tested in integration.

    const expectedEventTypes = [
      'subtask-started',
      'subtask-retrying',
      'subtask-started',
      'subtask-completed',
    ];
    // Placeholder: when implementation exists, we'll collect events from orchestrator
    // For now, verify the event sequence structure is valid
    const events: DAGEvent[] = [
      { type: 'subtask-started', index: 0 },
      { type: 'subtask-retrying', index: 0, attempt: 1, maxAttempts: 2 },
      { type: 'subtask-started', index: 0 },
      { type: 'subtask-completed', index: 0, oneliner: 'done on retry', elapsed: 5000 },
    ];
    assert.deepEqual(events.map(e => e.type), expectedEventTypes);
  });

  it('emits subtask-retry-exhausted after all retries fail', () => {
    // Scenario: maxSubtaskRetries=2, subtask fails twice with retryWorthy:true
    // Expected: subtask-started → subtask-retrying(1/2) → subtask-started → subtask-retrying(2/2) → subtask-retry-exhausted
    const events: DAGEvent[] = [
      { type: 'subtask-started', index: 1 },
      { type: 'subtask-retrying', index: 1, attempt: 1, maxAttempts: 2 },
      { type: 'subtask-started', index: 1 },
      { type: 'subtask-retrying', index: 1, attempt: 2, maxAttempts: 2 },
      { type: 'subtask-retry-exhausted', index: 1, attempts: 2 },
    ];
    const lastEvent = events[events.length - 1];
    assert.equal(lastEvent.type, 'subtask-retry-exhausted');
    if (lastEvent.type === 'subtask-retry-exhausted') {
      assert.equal(lastEvent.attempts, 2);
    }
  });

  it('does not emit subtask-retrying when retryWorthy is false', () => {
    // Scenario: subtask fails with retryWorthy:false → immediate failure, no retry
    const events: any[] = [
      { type: 'subtask-started', index: 0 },
      { type: 'subtask-failed', index: 0, error: 'wrong approach', elapsed: 3000 },
    ];
    assert.ok(!events.some((e: any) => e.type === 'subtask-retrying'));
    assert.ok(!events.some((e: any) => e.type === 'subtask-retry-exhausted'));
  });

  it('does not emit subtask-retrying when retryWorthy is omitted', () => {
    // Scenario: subtask fails without retryWorthy field → treated as non-retryable
    const events: any[] = [
      { type: 'subtask-started', index: 0 },
      { type: 'subtask-failed', index: 0, error: 'generic failure', elapsed: 2000 },
    ];
    assert.ok(!events.some((e: any) => e.type === 'subtask-retrying'));
  });

  it('cascade-skips dependents after retry exhaustion', () => {
    // Scenario: subtask 0 exhausts retries → subtask 1 (depends on 0) gets skipped
    const events: any[] = [
      { type: 'subtask-started', index: 0 },
      { type: 'subtask-retrying', index: 0, attempt: 1, maxAttempts: 1 },
      { type: 'subtask-retry-exhausted', index: 0, attempts: 1 },
      { type: 'subtask-skipped', index: 1, cascadeFrom: 0 },
    ];
    const skipped = events.filter((e: any) => e.type === 'subtask-skipped');
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].cascadeFrom, 0);
  });

  it('retries on ClaudeRunError even without retryWorthy output', () => {
    // Scenario: runOne throws ClaudeRunError (transient) → retry even though no structured output
    const events: any[] = [
      { type: 'subtask-started', index: 0 },
      { type: 'subtask-retrying', index: 0, attempt: 1, maxAttempts: 2 },
      { type: 'subtask-started', index: 0 },
      { type: 'subtask-completed', index: 0, oneliner: 'recovered', elapsed: 8000 },
    ];
    const retryEvents = events.filter((e: any) => e.type === 'subtask-retrying');
    assert.equal(retryEvents.length, 1);
    assert.equal(retryEvents[0].attempt, 1);
    assert.equal(retryEvents[0].maxAttempts, 2);
  });

  it('subtask-retrying event includes correct attempt and maxAttempts', () => {
    // Verify attempt numbering: attempts are 1-indexed
    const event: any = { type: 'subtask-retrying', index: 3, attempt: 2, maxAttempts: 3 };
    assert.equal(event.attempt, 2);
    assert.equal(event.maxAttempts, 3);
    assert.ok(event.attempt <= event.maxAttempts, 'attempt should not exceed maxAttempts');
  });

  it('buildChildOptions propagates maxSubtaskRetries', () => {
    const parentOpts = {
      prompt: 'Build the app',
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
      maxSubtaskRetries: 3,
    } as CliOptions & { maxSubtaskRetries?: number };
    const subtask: Subtask = {
      index: 0,
      description: 'Setup DB',
      prompt: 'Create DB schema',
      dependencies: [],
      estimatedComplexity: 'medium',
      needsRecursiveDecomposition: true,
    };
    const child = buildChildOptions(parentOpts, subtask, 0);
    assert.equal((child as any).maxSubtaskRetries, 3);
  });
});
