import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../cli.ts';

describe('parseArgs', () => {
  it('parses minimal invocation (just a prompt)', () => {
    const opts = parseArgs(['Do something']);
    assert.equal(opts.prompt, 'Do something');
    assert.equal(opts.workDir, process.cwd());
    assert.deepEqual(opts.pipeline, ['Plan', 'Execute', 'Verify']);
    assert.deepEqual(opts.backend, { type: 'cli' });
    assert.equal(opts.autoApprove, false);
    assert.equal(opts.noMemory, false);
    assert.equal(opts.noSummary, false);
  });

  it('parses --workdir flag', () => {
    const opts = parseArgs(['--workdir', '/tmp/test', 'Do something']);
    assert.equal(opts.workDir, '/tmp/test');
  });

  it('parses --backend flag', () => {
    const opts = parseArgs(['--backend', 'sdk', 'Do something']);
    assert.deepEqual(opts.backend, { type: 'sdk' });
  });

  it('parses --pipeline flag', () => {
    const opts = parseArgs(['--pipeline', 'Plan,Execute', 'Do something']);
    assert.deepEqual(opts.pipeline, ['Plan', 'Execute']);
  });

  it('parses --yolo flag (auto-approve + skip permissions)', () => {
    const opts = parseArgs(['--yolo', 'Do something']);
    assert.equal(opts.autoApprove, true);
  });

  it('parses --auto-approve flag', () => {
    const opts = parseArgs(['--auto-approve', 'Do something']);
    assert.equal(opts.autoApprove, true);
  });

  it('parses --timeout flag', () => {
    const opts = parseArgs(['--timeout', '120', 'Do something']);
    assert.equal(opts.timeoutSeconds, 120);
  });

  it('parses --max-concurrency flag', () => {
    const opts = parseArgs(['--max-concurrency', '4', 'Do something']);
    assert.equal(opts.maxConcurrency, 4);
  });

  it('parses --no-memory flag', () => {
    const opts = parseArgs(['--no-memory', 'Do something']);
    assert.equal(opts.noMemory, true);
  });

  it('parses --no-summary flag', () => {
    const opts = parseArgs(['--no-summary', 'Do something']);
    assert.equal(opts.noSummary, true);
  });

  it('throws when no prompt provided', () => {
    assert.throws(() => parseArgs([]), /prompt is required/i);
  });

  it('throws for unknown backend', () => {
    assert.throws(() => parseArgs(['--backend', 'openai', 'Do something']), /unknown backend/i);
  });

  it('treats "runs" as subcommand, not prompt', () => {
    const opts = parseArgs(['runs']);
    assert.equal(opts.prompt, '');
    assert.equal((opts as any).subcommand, 'runs');
  });

  it('parses "runs --last" subcommand', () => {
    const opts = parseArgs(['runs', '--last']);
    assert.equal((opts as any).subcommand, 'runs');
    assert.equal((opts as any).runsLast, true);
  });
});
