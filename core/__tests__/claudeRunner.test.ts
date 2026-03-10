import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseUsageFromCliOutput,
  estimateCost,
  checkClaudeCli,
  ClaudeRunError,
  runClaudeCli,
  buildCliArgs,
  extractFailureFromRawOutput,
  extractTextFromStreamJson,
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

  describe('extractFailureFromRawOutput', () => {
    it('returns no-output fallback for empty string', () => {
      const result = extractFailureFromRawOutput('');
      assert.deepEqual(result, {
        success: false,
        summary: 'No output from executor',
        oneliner: 'No output',
        retryWorthy: true,
      });
    });

    it('returns no-output fallback for whitespace-only string', () => {
      const result = extractFailureFromRawOutput('   \n\t  ');
      assert.deepEqual(result, {
        success: false,
        summary: 'No output from executor',
        oneliner: 'No output',
        retryWorthy: true,
      });
    });

    it('returns no-output fallback for null input', () => {
      const result = extractFailureFromRawOutput(null as unknown as string);
      assert.deepEqual(result, {
        success: false,
        summary: 'No output from executor',
        oneliner: 'No output',
        retryWorthy: true,
      });
    });

    it('returns no-output fallback for undefined input', () => {
      const result = extractFailureFromRawOutput(undefined as unknown as string);
      assert.deepEqual(result, {
        success: false,
        summary: 'No output from executor',
        oneliner: 'No output',
        retryWorthy: true,
      });
    });

    it('detects "Error:" pattern and extracts message', () => {
      const raw = 'Some preamble\nError: Something went wrong\nMore text';
      const result = extractFailureFromRawOutput(raw);
      assert.ok(result !== null);
      assert.equal(result!.success, false);
      assert.equal(result!.retryWorthy, true);
      assert.ok(result!.summary.includes('Something went wrong'), `summary should contain error message, got: ${result!.summary}`);
    });

    it('detects lowercase "error" pattern', () => {
      const raw = 'fatal error occurred during execution';
      const result = extractFailureFromRawOutput(raw);
      assert.ok(result !== null);
      assert.equal(result!.success, false);
      assert.equal(result!.retryWorthy, true);
    });

    it('detects "permission denied" and marks not retryWorthy', () => {
      const raw = 'bash: ./script.sh: permission denied\nExecution failed';
      const result = extractFailureFromRawOutput(raw);
      assert.ok(result !== null);
      assert.equal(result!.success, false);
      assert.equal(result!.retryWorthy, false);
      assert.ok(
        result!.summary.toLowerCase().includes('permission denied'),
        `summary should contain 'permission denied', got: ${result!.summary}`,
      );
    });

    it('detects SIGTERM and marks retryWorthy', () => {
      const raw = 'Process received SIGTERM, shutting down';
      const result = extractFailureFromRawOutput(raw);
      assert.ok(result !== null);
      assert.equal(result!.success, false);
      assert.equal(result!.retryWorthy, true);
    });

    it('detects timeout and marks retryWorthy', () => {
      const raw = 'Command timed out after 120 seconds\ntimeout reached';
      const result = extractFailureFromRawOutput(raw);
      assert.ok(result !== null);
      assert.equal(result!.success, false);
      assert.equal(result!.retryWorthy, true);
    });

    it('returns missing-JSON fallback for normal text output without error patterns', () => {
      const raw = 'I have completed the task successfully.\nAll files were updated as requested.\nThe implementation looks good.';
      const result = extractFailureFromRawOutput(raw);
      assert.deepEqual(result, {
        success: false,
        summary: 'Executor did not produce structured output',
        oneliner: 'Missing JSON output',
        retryWorthy: true,
      });
    });
  });

  describe('extractTextFromStreamJson', () => {
    it('extracts text from a result line with type result and result string', () => {
      const ndjson = [
        JSON.stringify({ type: 'system', subtype: 'init', session_id: 'abc' }),
        JSON.stringify({ type: 'result', subtype: 'success', result: '# Hello World\n\nThis is the final output.' }),
      ].join('\n');

      const text = extractTextFromStreamJson(ndjson);
      assert.equal(text, '# Hello World\n\nThis is the final output.');
    });

    it('extracts text from assistant message lines when no result line exists', () => {
      const ndjson = [
        JSON.stringify({ type: 'system', subtype: 'init', session_id: 'abc' }),
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              { type: 'thinking', thinking: 'Let me think...' },
              { type: 'text', text: 'First part. ' },
              { type: 'text', text: 'Second part.' },
            ],
          },
        }),
      ].join('\n');

      const text = extractTextFromStreamJson(ndjson);
      assert.equal(text, 'First part. Second part.');
    });

    it('returns raw output when no JSON can be parsed', () => {
      const raw = 'this is not json\nneither is this';
      const text = extractTextFromStreamJson(raw);
      assert.equal(text, raw);
    });

    it('handles mixed NDJSON with system, assistant, rate_limit, and result lines', () => {
      const ndjson = [
        JSON.stringify({ type: 'system', subtype: 'init', cwd: '/tmp', session_id: 'sess1' }),
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              { type: 'thinking', thinking: 'hmm' },
              { type: 'text', text: 'Some intermediate text' },
            ],
          },
        }),
        JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }),
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          result: '## Final Summary\n\nEverything worked.',
          session_id: 'sess1',
        }),
      ].join('\n');

      const text = extractTextFromStreamJson(ndjson);
      // Should prefer the result field over assistant messages
      assert.equal(text, '## Final Summary\n\nEverything worked.');
    });

    it('falls back to assistant text when result field is not a string', () => {
      const ndjson = [
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: 'Only assistant text here' }],
          },
        }),
        JSON.stringify({ type: 'result', subtype: 'success', result: { some: 'object' } }),
      ].join('\n');

      const text = extractTextFromStreamJson(ndjson);
      assert.equal(text, 'Only assistant text here');
    });

    it('returns raw output for empty string', () => {
      assert.equal(extractTextFromStreamJson(''), '');
    });

    it('strips wrapping markdown fences from result text', () => {
      const ndjson = [
        '{"type":"system","subtype":"init"}',
        '{"type":"result","result":"```markdown\\n# Title\\n\\nContent here\\n```"}',
      ].join('\n');

      const text = extractTextFromStreamJson(ndjson);
      assert.equal(text, '# Title\n\nContent here');
    });

    it('strips wrapping md fences from assistant text', () => {
      const ndjson = [
        '{"type":"assistant","message":{"content":[{"type":"text","text":"```md\\n# Doc\\n\\nBody\\n```"}]}}',
      ].join('\n');

      const text = extractTextFromStreamJson(ndjson);
      assert.equal(text, '# Doc\n\nBody');
    });
  });
});
