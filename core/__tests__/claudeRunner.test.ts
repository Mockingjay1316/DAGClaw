import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseUsageFromCliOutput,
  estimateCost,
  checkClaudeCli,
  ClaudeRunError,
  runClaudeCli,
  buildCliArgs,
} from '../claudeRunner.ts';
import type { RunClaudeOptions } from '../claudeRunner.ts';

describe('claudeRunner', () => {
  describe('parseUsageFromCliOutput', () => {
    it('parses usage stats from stream-json result line', () => {
      const output = JSON.stringify({
        type: 'result',
        result: {
          usage: {
            input_tokens: 1000,
            output_tokens: 500,
            cache_read_input_tokens: 200,
            cache_creation_input_tokens: 50,
          },
        },
      });

      const usage = parseUsageFromCliOutput(output);
      assert.equal(usage.inputTokens, 1000);
      assert.equal(usage.outputTokens, 500);
      assert.equal(usage.cacheReadTokens, 200);
      assert.equal(usage.cacheCreationTokens, 50);
    });

    it('returns zeros for missing fields', () => {
      const usage = parseUsageFromCliOutput('{}');
      assert.equal(usage.inputTokens, 0);
      assert.equal(usage.outputTokens, 0);
    });

    it('returns zeros for unparseable input', () => {
      const usage = parseUsageFromCliOutput('not json');
      assert.equal(usage.inputTokens, 0);
    });
  });

  describe('estimateCost', () => {
    it('estimates cost from token counts', () => {
      const cost = estimateCost(1000, 500, 200, 50);
      assert.ok(cost > 0);
      assert.ok(typeof cost === 'number');
    });

    it('returns 0 for zero tokens', () => {
      assert.equal(estimateCost(0, 0, 0, 0), 0);
    });
  });

  describe('checkClaudeCli', () => {
    it('returns a boolean', () => {
      const result = checkClaudeCli();
      assert.equal(typeof result, 'boolean');
    });
  });

  describe('ClaudeRunError', () => {
    it('stores partial output and exit code', () => {
      const err = new ClaudeRunError('timed out', 'partial stdout content', null);
      assert.equal(err.message, 'timed out');
      assert.equal(err.partialOutput, 'partial stdout content');
      assert.equal(err.exitCode, null);
      assert.equal(err.name, 'ClaudeRunError');
    });

    it('stores numeric exit code', () => {
      const err = new ClaudeRunError('exited with code 1', 'some output', 1);
      assert.equal(err.exitCode, 1);
      assert.equal(err.partialOutput, 'some output');
    });

    it('is an instance of Error', () => {
      const err = new ClaudeRunError('test', '', null);
      assert.ok(err instanceof Error);
      assert.ok(err instanceof ClaudeRunError);
    });

    it('handles empty partial output', () => {
      const err = new ClaudeRunError('failed', '', 2);
      assert.equal(err.partialOutput, '');
    });
  });

  describe('runClaudeCli --model flag', () => {
    it('RunClaudeOptions accepts a model field', () => {
      // Type-level test: constructing an options object with model should compile
      const opts: RunClaudeOptions = {
        prompt: 'test prompt',
        systemPrompt: 'you are helpful',
        workDir: '/tmp',
        backend: { type: 'cli' },
        model: 'claude-3-haiku-20240307',
      };
      assert.equal(opts.model, 'claude-3-haiku-20240307');
    });

    it('includes --model in CLI args when model is provided', () => {
      const args = buildCliArgs({
        prompt: 'test prompt',
        systemPrompt: 'you are helpful',
        workDir: '/tmp',
        backend: { type: 'cli' },
        model: 'claude-3-haiku-20240307',
      });
      const modelFlagIndex = args.indexOf('--model');
      assert.ok(modelFlagIndex !== -1, 'args should contain --model flag');
      assert.equal(args[modelFlagIndex + 1], 'claude-3-haiku-20240307', 'model value should follow --model flag');
    });

    it('does not include --model in CLI args when model is not provided', () => {
      const args = buildCliArgs({
        prompt: 'test prompt',
        systemPrompt: 'you are helpful',
        workDir: '/tmp',
        backend: { type: 'cli' },
      });
      assert.ok(!args.includes('--model'), 'args should NOT contain --model flag when model is not set');
    });
  });
});
