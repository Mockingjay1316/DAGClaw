import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { PipelineState, CliOptions, Plan, ContextSnapshot } from '../types.ts';
import type { MemoryManager } from '../memoryManager.ts';
import type { RunLogger } from '../runLogger.ts';
import { distillMemory } from '../memoryDistiller.ts';

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

function makeMockLogger(): RunLogger & { appendStageLog: ReturnType<typeof mock.fn>; writeRunMemory: ReturnType<typeof mock.fn> } {
  return {
    logEvent: mock.fn(() => {}),
    info: mock.fn(() => {}),
    warn: mock.fn(() => {}),
    error: mock.fn(() => {}),
    appendStageLog: mock.fn(() => {}),
    writeRunMemory: mock.fn(() => {}),
  } as unknown as RunLogger & { appendStageLog: ReturnType<typeof mock.fn>; writeRunMemory: ReturnType<typeof mock.fn> };
}

function makeMockMemoryManager(): MemoryManager & { writeFile: ReturnType<typeof mock.fn> } {
  return {
    writeFile: mock.fn(() => {}),
    readAll: mock.fn(() => ''),
    readFile: mock.fn(() => null),
    listFiles: mock.fn(() => []),
    readSummaries: mock.fn(() => []),
    updateIndex: mock.fn(() => {}),
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

    it('calls memoryManager.writeFile with runId as filename and clean text directly', async () => {
      const state = makeMockState();
      const logger = makeMockLogger();
      const memoryManager = makeMockMemoryManager();
      const opts = makeMockOpts();

      await distillMemory('run-123', state, logger, memoryManager, opts, mockRunClaudeCli as any);

      assert.equal(memoryManager.writeFile.mock.callCount(), 1);
      const [filename, content] = memoryManager.writeFile.mock.calls[0].arguments;
      assert.equal(filename, 'run-123.md');
      // Content is passed through directly from the distiller
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

    it('writes error to stderr when distillation fails', async () => {
      const throwingRunner = mock.fn(async () => {
        throw new Error('Claude CLI failed');
      });

      const state = makeMockState();
      const logger = makeMockLogger();
      const memoryManager = makeMockMemoryManager();
      const opts = makeMockOpts();

      const chunks: string[] = [];
      const origWrite = process.stderr.write;
      process.stderr.write = ((chunk: string | Uint8Array) => {
        chunks.push(chunk.toString());
        return true;
      }) as typeof process.stderr.write;

      try {
        await distillMemory('run-123', state, logger, memoryManager, opts, throwingRunner as any);
      } finally {
        process.stderr.write = origWrite;
      }

      const output = chunks.join('');
      assert.ok(output.includes('Memory distillation failed'), 'should log failure message to stderr');
      assert.ok(output.includes('Claude CLI failed'), 'should include the original error message');
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

    it('saves raw NDJSON output to run directory via logger.appendStageLog', async () => {
      const state = makeMockState();
      const logger = makeMockLogger();
      const memoryManager = makeMockMemoryManager();
      const opts = makeMockOpts();

      await distillMemory('run-123', state, logger, memoryManager, opts, mockRunClaudeCli as any);

      assert.equal(logger.appendStageLog.mock.callCount(), 1);
      const [runId, stageName, data] = logger.appendStageLog.mock.calls[0].arguments;
      assert.equal(runId, 'run-123');
      assert.equal(stageName, 'memory-distillation');
      assert.equal(data, '# Memory\nSome insight');
    });

    it('saves per-run memory.md via logger.writeRunMemory', async () => {
      const state = makeMockState();
      const logger = makeMockLogger();
      const memoryManager = makeMockMemoryManager();
      const opts = makeMockOpts();

      await distillMemory('run-123', state, logger, memoryManager, opts, mockRunClaudeCli as any);

      assert.equal(logger.writeRunMemory.mock.callCount(), 1);
      const [runId, content] = logger.writeRunMemory.mock.calls[0].arguments;
      assert.equal(runId, 'run-123');
      assert.equal(content, '# Memory\nSome insight');
    });

    it('passes distiller output directly without modification', async () => {
      const structuredRunner = mock.fn(async () => ({
        rawOutput: '# Added REST API Routes\n\n> Implemented CRUD endpoints for tasks with Express router factory pattern.\n\n## Summary\n\nAdded four REST endpoints...',
        sessionId: 'test-session',
        usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0, estimatedCost: 0.001 },
      }));

      const state = makeMockState();
      const logger = makeMockLogger();
      const memoryManager = makeMockMemoryManager();
      const opts = makeMockOpts();

      await distillMemory('run-123', state, logger, memoryManager, opts, structuredRunner as any);

      const [, content] = memoryManager.writeFile.mock.calls[0].arguments as [string, string];
      // Content passed through directly — title, blockquote, and body intact
      assert.ok(content.startsWith('# Added REST API Routes'));
      assert.ok(content.includes('> Implemented CRUD'));
      assert.ok(content.includes('## Summary'));
    });

    it('extracts clean text from NDJSON stream for memoryManager.writeFile', async () => {
      const ndjsonOutput = '{"type":"system","subtype":"init"}\n{"type":"assistant","message":{"content":[{"type":"text","text":"# Distilled Memory\\nKey insight"}]}}\n{"type":"result","subtype":"success","result":"# Distilled Memory\\nKey insight"}';
      const ndjsonRunner = mock.fn(async () => ({
        rawOutput: ndjsonOutput,
        sessionId: 'test-session',
        usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0, estimatedCost: 0.001 },
      }));

      const state = makeMockState();
      const logger = makeMockLogger();
      const memoryManager = makeMockMemoryManager();
      const opts = makeMockOpts();

      await distillMemory('run-123', state, logger, memoryManager, opts, ndjsonRunner as any);

      // memoryManager.writeFile should receive the clean extracted text, not raw NDJSON
      const [filename, content] = memoryManager.writeFile.mock.calls[0].arguments;
      assert.equal(filename, 'run-123.md');
      // Content already starts with # title, kept as-is
      assert.equal(content, '# Distilled Memory\nKey insight');

      // logger.appendStageLog should receive the raw NDJSON
      const [, , rawData] = logger.appendStageLog.mock.calls[0].arguments;
      assert.equal(rawData, ndjsonOutput);

      // logger.writeRunMemory should receive clean text
      const [, memContent] = logger.writeRunMemory.mock.calls[0].arguments;
      assert.equal(memContent, '# Distilled Memory\nKey insight');
    });
  });
});
