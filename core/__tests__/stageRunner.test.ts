import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildStagePrompt,
  parseStageOutput,
} from '../claudeRunner.ts';
import {
  PlanSchema,
  ExecutorOutputSchema,
  VerificationResultSchema,
} from '../types.ts';

describe('buildStagePrompt', () => {
  it('interpolates template placeholders', () => {
    const result = buildStagePrompt(
      'Working dir: {{workDir}}\nTask: {{prompt}}',
      { workDir: '/tmp/project', prompt: 'Build a REST API' },
    );
    assert.ok(result.includes('/tmp/project'));
    assert.ok(result.includes('Build a REST API'));
  });

  it('leaves unknown placeholders unchanged', () => {
    const result = buildStagePrompt('{{known}} and {{unknown}}', { known: 'yes' });
    assert.equal(result, 'yes and {{unknown}}');
  });
});

describe('parseStageOutput', () => {
  it('parses Plan output', () => {
    const plan = {
      summary: 'Test plan',
      subtasks: [],
      worthDistilling: false,
    };
    const result = parseStageOutput(PlanSchema, JSON.stringify(plan));
    assert.ok(result !== null);
    assert.equal((result as any).summary, 'Test plan');
  });

  it('parses Execute output', () => {
    const executor = { success: true, summary: 'Did the thing', oneliner: 'thing done' };
    const result = parseStageOutput(ExecutorOutputSchema, JSON.stringify(executor));
    assert.ok(result !== null);
    assert.equal((result as any).oneliner, 'thing done');
  });

  it('parses Verify output', () => {
    const verify = {
      overallPass: true,
      subtaskResults: [],
      skippedIndices: [],
      integrationResult: { pass: true, summary: 'OK', issues: [] },
    };
    const result = parseStageOutput(VerificationResultSchema, JSON.stringify(verify));
    assert.ok(result !== null);
    assert.equal((result as any).overallPass, true);
  });

  it('returns null for invalid JSON', () => {
    assert.equal(parseStageOutput(PlanSchema, 'not json'), null);
  });

  it('returns null for schema mismatch', () => {
    assert.equal(parseStageOutput(PlanSchema, JSON.stringify({ wrong: 'shape' })), null);
  });
});
