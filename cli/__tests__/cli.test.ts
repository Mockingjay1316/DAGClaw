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

describe('dag-stages parsing', () => {
  it('defaults dagStages to ["Execute"]', () => {
    const opts = parseArgs(['Do something']);
    assert.deepEqual(opts.dagStages, ['Execute']);
  });

  it('parses --dag-stages flag', () => {
    const opts = parseArgs(['--dag-stages', 'Execute,Lint', 'Do something']);
    assert.deepEqual(opts.dagStages, ['Execute', 'Lint']);
  });

  it('trims whitespace in --dag-stages', () => {
    const opts = parseArgs(['--dag-stages', 'Execute, Lint, Verify', 'Do something']);
    assert.deepEqual(opts.dagStages, ['Execute', 'Lint', 'Verify']);
  });

  it('runs subcommand defaults dagStages', () => {
    const opts = parseArgs(['runs']);
    assert.deepEqual(opts.dagStages, ['Execute']);
  });
});

describe('model selection flags', () => {
  it('parses --model flag', () => {
    const opts = parseArgs(['--model', 'claude-3-haiku-20240307', 'Do something']);
    assert.equal(opts.model, 'claude-3-haiku-20240307');
  });

  it('parses --dag-model flag', () => {
    const opts = parseArgs(['--dag-model', 'claude-3-opus-20240229', 'Do something']);
    assert.equal(opts.dagModel, 'claude-3-opus-20240229');
  });

  it('model is undefined when --model flag is not provided', () => {
    const opts = parseArgs(['Do something']);
    assert.equal(opts.model, undefined);
  });

  it('dagModel is undefined when --dag-model flag is not provided', () => {
    const opts = parseArgs(['Do something']);
    assert.equal(opts.dagModel, undefined);
  });

  it('parses both --model and --dag-model together', () => {
    const opts = parseArgs(['--model', 'claude-3-haiku-20240307', '--dag-model', 'claude-3-opus-20240229', 'Do something']);
    assert.equal(opts.model, 'claude-3-haiku-20240307');
    assert.equal(opts.dagModel, 'claude-3-opus-20240229');
  });
});

describe('custom stage loading', () => {
  it('parseArgs with --pipeline including custom stage names parses correctly', () => {
    const opts = parseArgs(['--pipeline', 'Plan,Execute,Test,Verify', 'Do something']);
    assert.deepEqual(opts.pipeline, ['Plan', 'Execute', 'Test', 'Verify']);
  });

  it('parseArgs preserves whitespace-trimmed custom stage names', () => {
    const opts = parseArgs(['--pipeline', 'Plan, Execute, Lint, Deploy', 'Do something']);
    assert.deepEqual(opts.pipeline, ['Plan', 'Execute', 'Lint', 'Deploy']);
  });

  it('pipeline validation: unknown stages are caught at integration level', () => {
    // parseArgs itself does NOT validate stage names — it only splits the string.
    // Validation happens in main() against the loaded stageRegistry.
    // Here we verify parseArgs happily accepts unknown stage names,
    // confirming validation must happen downstream.
    const opts = parseArgs(['--pipeline', 'Plan,NonExistent,Verify', 'Do something']);
    assert.deepEqual(opts.pipeline, ['Plan', 'NonExistent', 'Verify']);

    // The actual validation in main() would throw:
    //   `Unknown stage "NonExistent" in pipeline. Available: Plan, Execute, Verify`
    // This is an integration-level concern tested via the stageRegistry check in cli.ts main().
  });
});
