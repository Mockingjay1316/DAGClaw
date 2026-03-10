import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { PipelineState, CliOptions, Plan, ContextSnapshot } from '../types.ts';
import type { MemoryManager } from '../memoryManager.ts';
import type { RunLogger } from '../runLogger.ts';
import { slugify, distillMemory } from '../memoryDistiller.ts';

// Mock runner injected via dependency injection (no mock.module needed)
const mockRunClaudeCli = mock.fn(async () => ({
  rawOutput: '# Memory\nSome insight',
  sessionId: 'test-session',
  usage: {
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    estimatedCost: 0.001,
  },
}));

function makeMockLogger(): RunLogger {
  return {
    logEvent: mock.fn(() => {}),
    info: mock.fn(() => {}),
    warn: mock.fn(() => {}),
    error: mock.fn(() => {}),
  } as unknown as RunLogger;
}

function makeMockMemoryManager(): MemoryManager & { writeFile: ReturnType<typeof mock.fn> } {
  return {
    writeFile: mock.fn(() => {}),
    readAll: mock.fn(() => ''),
    readFile: mock.fn(() => null),
    listFiles: mock.fn(() => []),
  } as unknown as MemoryManager & { writeFile: ReturnType<typeof mock.fn> };
}

function makeMockOpts(overrides: Partial<CliOptions> = {}): CliOptions {
  return {
    prompt: 'Add memory distillation pipeline',
    workDir: '/tmp/test',
    pipeline: ['Plan', 'Execute', 'Verify'],
    backend: { type: 'cli' },
    permissionMode: 'auto',
    autoApprove: false,
    maxRetries: 1,
    maxConcurrency: 4,
    maxDepth: 2,
    timeoutSeconds: 300,
    noSummary: false,
    noMemory: false,
    dagStages: ['Execute'],
    ...overrides,
  };
}

function makeMockState(overrides: Partial<PipelineState> = {}): PipelineState {
  const plan: Plan = {
    summary: 'Add memory distillation',
    subtasks: [
      {
        index: 0,
        description: 'Create memoryDistiller module',
        prompt: 'Create the module',
        dependencies: [],
        estimatedComplexity: 'medium',
        needsRecursiveDecomposition: false,
      },
      {
        index: 1,
        description: 'Integrate with orchestrator',
        prompt: 'Wire it up',
        dependencies: [0],
        estimatedComplexity: 'low',
        needsRecursiveDecomposition: false,
      },
    ],
    qualityFlag: null,
    worthDistilling: true,
  };

  const subtaskSnapshots = new Map<number, ContextSnapshot>();
  subtaskSnapshots.set(0, {
    nodeId: 'subtask-0',
    stage: 'Execute',
    subtaskIndex: 0,
    oneliner: 'Created memoryDistiller.ts',
    filesModified: ['core/memoryDistiller.ts'],
    summary: 'Implemented the distillation module with slugify and distillMemory exports',
    sessionId: 'session-0',
  });
  subtaskSnapshots.set(1, {
    nodeId: 'subtask-1',
    stage: 'Execute',
    subtaskIndex: 1,
    oneliner: 'Integrated distiller into orchestrator',
    filesModified: ['core/taskOrchestrator.ts'],
    summary: 'Added distillMemory call after cost summary in the pipeline',
    sessionId: 'session-1',
  });

  return {
    prompt: 'Add memory distillation pipeline',
    workDir: '/tmp/test',
    plan,
    subtaskSnapshots,
    skippedIndices: new Set<number>(),
    memoryContext: '',
    verification: {
      overallPass: true,
      subtaskResults: [
        { subtaskIndex: 0, pass: true, summary: 'Looks good', retryRecommended: false },
        { subtaskIndex: 1, pass: true, summary: 'Looks good', retryRecommended: false },
      ],
      skippedIndices: [],
      integrationResult: {
        pass: true,
        summary: 'All integration checks passed',
        issues: [],
      },
    },
    dagPalette: ['Execute'],
    postStages: ['Verify'],
    stageDescriptions: '',
    ...overrides,
  };
}

describe('memoryDistiller', () => {
  beforeEach(() => {
    mockRunClaudeCli.mock.resetCalls();
  });

  describe('slugify', () => {
    it('converts text to lowercase hyphenated slug', () => {
      assert.equal(slugify('Add memory distillation pipeline'), 'add-memory-distillation-pipeline');
    });

    it('handles special characters', () => {
      assert.equal(slugify('Fix bug #123 (urgent!)'), 'fix-bug-123-urgent');
    });

    it('truncates to 50 chars max', () => {
      const longText = 'a'.repeat(60);
      const result = slugify(longText);
      assert.ok(result.length <= 50, `Expected length <= 50, got ${result.length}`);
    });

    it('handles empty string', () => {
      assert.equal(slugify(''), 'untitled');
    });
  });

  describe('distillMemory', () => {
    it('builds correct prompt with plan and subtask details', async () => {
      const state = makeMockState();
      const logger = makeMockLogger();
      const memoryManager = makeMockMemoryManager();
      const opts = makeMockOpts();

      await distillMemory('run-123', state, logger, memoryManager, opts, mockRunClaudeCli as any);

      assert.equal(mockRunClaudeCli.mock.callCount(), 1);
      const callArgs = (mockRunClaudeCli.mock.calls as any)[0].arguments[0];
      const prompt = callArgs.prompt as string;

      // Should contain plan summary
      assert.ok(prompt.includes('Add memory distillation'), `Prompt should contain plan summary, got: ${prompt}`);

      // Should contain subtask descriptions
      assert.ok(prompt.includes('Create memoryDistiller module'), `Prompt should contain subtask description`);
      assert.ok(prompt.includes('Integrate with orchestrator'), `Prompt should contain subtask description`);

      // Should contain subtask outcomes/summaries
      assert.ok(
        prompt.includes('Implemented the distillation module') || prompt.includes('Created memoryDistiller.ts'),
        `Prompt should contain subtask outcomes`,
      );

      // Should contain verification result
      assert.ok(
        prompt.includes('pass') || prompt.includes('true') || prompt.includes('PASSED'),
        `Prompt should contain verification result`,
      );
    });

    it('calls memoryManager.writeFile with slugified filename', async () => {
      const state = makeMockState();
      const logger = makeMockLogger();
      const memoryManager = makeMockMemoryManager();
      const opts = makeMockOpts();

      await distillMemory('run-123', state, logger, memoryManager, opts, mockRunClaudeCli as any);

      assert.equal(memoryManager.writeFile.mock.callCount(), 1);
      const [filename, content] = memoryManager.writeFile.mock.calls[0].arguments;
      assert.equal(filename, 'add-memory-distillation.md');
      assert.equal(content, '# Memory\nSome insight');
    });

    it('uses no tools (allowedTools is empty array)', async () => {
      const state = makeMockState();
      const logger = makeMockLogger();
      const memoryManager = makeMockMemoryManager();
      const opts = makeMockOpts();

      await distillMemory('run-123', state, logger, memoryManager, opts, mockRunClaudeCli as any);

      assert.equal(mockRunClaudeCli.mock.callCount(), 1);
      const callArgs = (mockRunClaudeCli.mock.calls as any)[0].arguments[0];
      assert.deepEqual(callArgs.allowedTools, []);
    });

    it('does not throw when runClaudeCli throws an error', async () => {
      const throwingRunner = mock.fn(async () => {
        throw new Error('Claude CLI failed');
      });

      const state = makeMockState();
      const logger = makeMockLogger();
      const memoryManager = makeMockMemoryManager();
      const opts = makeMockOpts();

      // Should NOT throw
      await assert.doesNotReject(() => distillMemory('run-123', state, logger, memoryManager, opts, throwingRunner as any));
    });

    it('passes model=sonnet by default to runner', async () => {
      const state = makeMockState();
      const logger = makeMockLogger();
      const memoryManager = makeMockMemoryManager();
      const opts = makeMockOpts();

      await distillMemory('run-123', state, logger, memoryManager, opts, mockRunClaudeCli as any);

      const callArgs = (mockRunClaudeCli.mock.calls as any)[0].arguments[0];
      assert.equal(callArgs.model, 'sonnet');
    });

    it('uses custom distillModel when specified', async () => {
      const state = makeMockState();
      const logger = makeMockLogger();
      const memoryManager = makeMockMemoryManager();
      const opts = makeMockOpts({ distillModel: 'opus' });

      await distillMemory('run-123', state, logger, memoryManager, opts, mockRunClaudeCli as any);

      const callArgs = (mockRunClaudeCli.mock.calls as any)[0].arguments[0];
      assert.equal(callArgs.model, 'opus');
    });
  });
});
