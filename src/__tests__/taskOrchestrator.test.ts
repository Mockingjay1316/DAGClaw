import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatPlanForDisplay,
  detectSharedResourceConflicts,
  aggregateUsage,
  getFilesModifiedByGit,
  isGitRepo,
} from '../taskOrchestrator.ts';
import type { Plan, UsageStats } from '../types.ts';

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
    durationMs: 1000,
  });

  it('sums token counts across multiple UsageStats', () => {
    const stats = [makeUsage(100, 50), makeUsage(200, 100)];
    const total = aggregateUsage(stats);
    assert.equal(total.inputTokens, 300);
    assert.equal(total.outputTokens, 150);
  });

  it('sums costs and durations', () => {
    const stats = [makeUsage(100, 50), makeUsage(200, 100)];
    const total = aggregateUsage(stats);
    assert.equal(total.estimatedCost, 0.02);
    assert.equal(total.durationMs, 2000);
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
