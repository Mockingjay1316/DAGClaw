import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  BUILTIN_STAGES,
  getStageDefinition,
  verifyResultInterpreter,
} from '../stageDefinitions.ts';
import type { PipelineState } from '../types.ts';

function makePipelineState(overrides?: Partial<PipelineState>): PipelineState {
  return {
    prompt: 'test prompt',
    workDir: '/tmp/test',
    plan: null,
    subtaskSnapshots: new Map(),
    skippedIndices: new Set(),
    memoryContext: '',
    verification: null,
    ...overrides,
  };
}

describe('stageDefinitions', () => {
  describe('BUILTIN_STAGES', () => {
    it('has Plan, Execute, and Verify stages', () => {
      assert.ok('Plan' in BUILTIN_STAGES);
      assert.ok('Execute' in BUILTIN_STAGES);
      assert.ok('Verify' in BUILTIN_STAGES);
    });

    it('Plan stage has approvalRequired=true', () => {
      assert.equal(BUILTIN_STAGES.Plan.approvalRequired, true);
    });

    it('Execute stage has parallel=true', () => {
      assert.equal(BUILTIN_STAGES.Execute.parallel, true);
    });

    it('Plan prompt instructs read-only behavior', () => {
      const prompt = BUILTIN_STAGES.Plan.runnerConfig.systemPrompt;
      assert.ok(prompt.includes('do not modify'));
    });

    it('Plan prompt instructs shared resource serialization', () => {
      const prompt = BUILTIN_STAGES.Plan.runnerConfig.systemPrompt;
      assert.ok(prompt.includes('sequential') || prompt.includes('dependency'));
    });

    it('Plan prompt instructs quality evaluation', () => {
      const prompt = BUILTIN_STAGES.Plan.runnerConfig.systemPrompt;
      assert.ok(prompt.includes('qualityFlag') || prompt.includes('quality'));
    });

    it('Execute prompt asks for summary output', () => {
      const prompt = BUILTIN_STAGES.Execute.runnerConfig.systemPrompt;
      assert.ok(prompt.includes('summary'));
    });

    it('Verify prompt instructs independent test generation', () => {
      const prompt = BUILTIN_STAGES.Verify.runnerConfig.systemPrompt;
      assert.ok(prompt.includes('test'));
    });
  });

  describe('Execute contextBuilder predecessorContext', () => {
    it('includes predecessor summaries for subtasks with dependencies', () => {
      const state = makePipelineState({
        plan: {
          summary: 'Test plan',
          subtasks: [],
          worthDistilling: false,
        },
        subtaskSnapshots: new Map([
          [0, {
            nodeId: '', stage: 'Execute', subtaskIndex: 0,
            oneliner: 'Set up Express', filesModified: ['app.ts'],
            summary: 'Created Express app with routes', sessionId: '',
          }],
          [1, {
            nodeId: '', stage: 'Execute', subtaskIndex: 1,
            oneliner: 'Added DB', filesModified: ['db.ts'],
            summary: 'Set up database layer', sessionId: '',
          }],
        ]),
      });

      const subtask = { index: 2, prompt: 'Wire things up', dependencies: [0, 1] };
      const ctx = BUILTIN_STAGES.Execute.contextBuilder(state, '/tmp/out.json', subtask);

      assert.ok(ctx.predecessorContext.includes('Subtask 0'));
      assert.ok(ctx.predecessorContext.includes('Created Express app with routes'));
      assert.ok(ctx.predecessorContext.includes('Subtask 1'));
      assert.ok(ctx.predecessorContext.includes('Set up database layer'));
    });

    it('returns empty predecessorContext when subtask has no dependencies', () => {
      const state = makePipelineState();
      const subtask = { index: 0, prompt: 'First task', dependencies: [] };
      const ctx = BUILTIN_STAGES.Execute.contextBuilder(state, '/tmp/out.json', subtask);
      assert.equal(ctx.predecessorContext, '');
    });

    it('returns empty predecessorContext when no subtask provided', () => {
      const state = makePipelineState();
      const ctx = BUILTIN_STAGES.Execute.contextBuilder(state, '/tmp/out.json');
      assert.equal(ctx.predecessorContext, '');
    });

    it('falls back to oneliner when summary is empty', () => {
      const state = makePipelineState({
        subtaskSnapshots: new Map([
          [0, {
            nodeId: '', stage: 'Execute', subtaskIndex: 0,
            oneliner: 'Set up Express', filesModified: [],
            summary: '', sessionId: '',
          }],
        ]),
      });

      const subtask = { index: 1, prompt: 'Next task', dependencies: [0] };
      const ctx = BUILTIN_STAGES.Execute.contextBuilder(state, '/tmp/out.json', subtask);
      assert.ok(ctx.predecessorContext.includes('Set up Express'));
    });
  });

  describe('Plan resultHandler', () => {
    it('receives parsed Plan object and sets state.plan', () => {
      const state = makePipelineState();
      const plan = {
        summary: 'Test plan',
        subtasks: [
          { index: 0, description: 'Do X', prompt: 'Do X', dependencies: [], estimatedComplexity: 'low' as const, needsRecursiveDecomposition: false },
        ],
        worthDistilling: false,
      };
      const msg = BUILTIN_STAGES.Plan.resultHandler(state, plan);
      assert.equal(state.plan, plan);
      assert.ok(msg.includes('1 subtask'));
    });

    it('returns error message when parsedOutput is null', () => {
      const state = makePipelineState();
      const msg = BUILTIN_STAGES.Plan.resultHandler(state, null);
      assert.ok(msg.includes('Failed'));
    });
  });

  describe('Execute resultHandler', () => {
    it('receives parsed executor output and sets snapshot', () => {
      const state = makePipelineState();
      const output = { success: true, summary: 'Did the thing', oneliner: 'thing done' };
      const subtask = { index: 0, prompt: 'Do X', dependencies: [] };
      const msg = BUILTIN_STAGES.Execute.resultHandler(state, output, subtask, 'session-1');
      assert.ok(state.subtaskSnapshots.has(0));
      assert.equal(state.subtaskSnapshots.get(0)!.summary, 'Did the thing');
      assert.ok(msg.includes('thing done'));
    });

    it('throws when executor reports failure', () => {
      const state = makePipelineState();
      const output = { success: false, summary: 'Permission denied', oneliner: 'failed' };
      const subtask = { index: 0, prompt: 'Do X', dependencies: [] };
      assert.throws(
        () => BUILTIN_STAGES.Execute.resultHandler(state, output, subtask),
        /Subtask 0 failed/,
      );
    });
  });

  describe('Verify resultHandler', () => {
    it('receives parsed verification result and sets state.verification', () => {
      const state = makePipelineState();
      const result = {
        overallPass: true,
        subtaskResults: [
          { subtaskIndex: 0, pass: true, summary: 'ok', retryRecommended: false },
        ],
        skippedIndices: [],
        integrationResult: { pass: true, summary: 'ok', issues: [] },
      };
      const msg = BUILTIN_STAGES.Verify.resultHandler(state, result);
      assert.equal(state.verification, result);
      assert.ok(msg.includes('passed'));
    });

    it('returns error message when parsedOutput is null', () => {
      const state = makePipelineState();
      const msg = BUILTIN_STAGES.Verify.resultHandler(state, null);
      assert.ok(msg.includes('Could not parse'));
    });
  });

  describe('getStageDefinition', () => {
    it('returns built-in stage by name', () => {
      const stage = getStageDefinition('Plan');
      assert.equal(stage.name, 'Plan');
    });

    it('throws for unknown stage', () => {
      assert.throws(() => getStageDefinition('Unknown'), /Unknown stage/);
    });
  });

  describe('verifyResultInterpreter', () => {
    it('returns pass=true when all pass', () => {
      const result = {
        overallPass: true,
        subtaskResults: [
          { subtaskIndex: 0, pass: true, summary: 'ok', retryRecommended: false },
        ],
        skippedIndices: [],
        integrationResult: { pass: true, summary: 'ok', issues: [] },
      };

      const interpreted = verifyResultInterpreter(result);
      assert.equal(interpreted.pass, true);
      assert.deepEqual(interpreted.failedIndices, []);
    });

    it('returns failed indices when subtasks fail', () => {
      const result = {
        overallPass: false,
        subtaskResults: [
          { subtaskIndex: 0, pass: true, summary: 'ok', retryRecommended: false },
          { subtaskIndex: 1, pass: false, summary: 'bad', retryRecommended: true },
          { subtaskIndex: 2, pass: false, summary: 'bad', retryRecommended: false },
        ],
        skippedIndices: [],
        integrationResult: { pass: false, summary: 'fail', issues: ['x'] },
      };

      const interpreted = verifyResultInterpreter(result);
      assert.equal(interpreted.pass, false);
      // Only index 1 has retryRecommended
      assert.deepEqual(interpreted.failedIndices, [1]);
    });
  });
});
