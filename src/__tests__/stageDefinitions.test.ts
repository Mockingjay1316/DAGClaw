import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  BUILTIN_STAGES,
  getStageDefinition,
  planSubtaskExtractor,
  verifyResultInterpreter,
} from '../stageDefinitions.ts';

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

    it('Verify stage has integrationVerifier=true', () => {
      assert.equal(BUILTIN_STAGES.Verify.integrationVerifier, true);
    });

    it('Plan prompt instructs read-only behavior', () => {
      const prompt = BUILTIN_STAGES.Plan.runnerConfig.systemPrompt!;
      assert.ok(prompt.includes('do not modify'));
    });

    it('Plan prompt instructs shared resource serialization', () => {
      const prompt = BUILTIN_STAGES.Plan.runnerConfig.systemPrompt!;
      assert.ok(prompt.includes('sequential') || prompt.includes('dependency'));
    });

    it('Plan prompt instructs quality evaluation', () => {
      const prompt = BUILTIN_STAGES.Plan.runnerConfig.systemPrompt!;
      assert.ok(prompt.includes('qualityFlag') || prompt.includes('quality'));
    });

    it('Execute prompt asks for summary output', () => {
      const prompt = BUILTIN_STAGES.Execute.runnerConfig.systemPrompt!;
      assert.ok(prompt.includes('summary'));
    });

    it('Verify prompt instructs independent test generation', () => {
      const prompt = BUILTIN_STAGES.Verify.runnerConfig.systemPrompt!;
      assert.ok(prompt.includes('test'));
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

  describe('planSubtaskExtractor', () => {
    it('extracts subtask definitions from plan', () => {
      const plan = {
        summary: 'test',
        subtasks: [
          { index: 0, description: 'd', prompt: 'p', dependencies: [], estimatedComplexity: 'low', needsRecursiveDecomposition: false },
          { index: 1, description: 'd2', prompt: 'p2', dependencies: [0], estimatedComplexity: 'medium', needsRecursiveDecomposition: false },
        ],
        worthDistilling: false,
      };

      const defs = planSubtaskExtractor(plan);
      assert.equal(defs.length, 2);
      assert.equal(defs[0].index, 0);
      assert.equal(defs[0].prompt, 'p');
      assert.deepEqual(defs[1].dependencies, [0]);
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
