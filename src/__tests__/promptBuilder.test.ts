import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  interpolateTemplate,
  buildPrompt,
  formatSnapshotCompact,
  formatSnapshotStandard,
} from '../promptBuilder.ts';
import type { ContextSnapshot } from '../types.ts';

const makeSnapshot = (overrides: Partial<ContextSnapshot> = {}): ContextSnapshot => ({
  nodeId: 'n1',
  stage: 'Execute',
  subtaskIndex: 0,
  oneliner: 'Set up routes',
  filesModified: ['src/routes.ts'],
  summary: 'Created Express routes for API endpoints',
  sessionId: 's1',
  ...overrides,
});

describe('interpolateTemplate', () => {
  it('replaces simple placeholders', () => {
    const result = interpolateTemplate(
      'Hello {{name}}, working in {{dir}}',
      { name: 'Alice', dir: '/tmp' }
    );
    assert.equal(result, 'Hello Alice, working in /tmp');
  });

  it('leaves unknown placeholders unchanged', () => {
    const result = interpolateTemplate('{{known}} and {{unknown}}', {
      known: 'yes',
    });
    assert.equal(result, 'yes and {{unknown}}');
  });

  it('handles empty context', () => {
    const result = interpolateTemplate('no placeholders here', {});
    assert.equal(result, 'no placeholders here');
  });

  it('replaces multiple occurrences', () => {
    const result = interpolateTemplate('{{x}} + {{x}}', { x: '1' });
    assert.equal(result, '1 + 1');
  });
});

describe('formatSnapshotCompact', () => {
  it('includes oneliner and files', () => {
    const snap = makeSnapshot();
    const formatted = formatSnapshotCompact(snap);
    assert.ok(formatted.includes('Set up routes'));
    assert.ok(formatted.includes('src/routes.ts'));
    assert.ok(!formatted.includes('Created Express'));
  });
});

describe('formatSnapshotStandard', () => {
  it('includes full summary and files', () => {
    const snap = makeSnapshot();
    const formatted = formatSnapshotStandard(snap);
    assert.ok(formatted.includes('Created Express routes'));
    assert.ok(formatted.includes('src/routes.ts'));
  });
});

describe('buildPrompt', () => {
  it('interpolates template with context', () => {
    const prompt = buildPrompt({
      template: 'Working dir: {{workDir}}\nTask: {{prompt}}',
      context: { workDir: '/tmp/project', prompt: 'fix the bug' },
    });
    assert.ok(prompt.includes('/tmp/project'));
    assert.ok(prompt.includes('fix the bug'));
  });

  it('includes predecessor context snapshots', () => {
    const prompt = buildPrompt({
      template: 'Task: {{prompt}}',
      context: { prompt: 'implement feature' },
      snapshots: [makeSnapshot()],
    });
    // Standard tier (no directIndices = all direct) uses summary
    assert.ok(prompt.includes('Created Express routes'));
    assert.ok(prompt.includes('src/routes.ts'));
  });

  it('includes memory context', () => {
    const prompt = buildPrompt({
      template: 'Task: {{prompt}}',
      context: { prompt: 'test' },
      memoryContext: '--- Memory ---\nUse TypeScript.',
    });
    assert.ok(prompt.includes('Use TypeScript'));
  });

  it('uses compact snapshots for transitive deps', () => {
    const direct = makeSnapshot({
      subtaskIndex: 1,
      oneliner: 'Direct dep oneliner',
      summary: 'Direct dep full summary with details',
    });
    const transitive = makeSnapshot({
      subtaskIndex: 0,
      oneliner: 'Transitive dep oneliner',
      summary: 'Transitive dep full summary with details',
    });

    const prompt = buildPrompt({
      template: 'Task: {{prompt}}',
      context: { prompt: 'test' },
      snapshots: [transitive, direct],
      directIndices: new Set([1]),
    });

    // Direct dep should have full summary
    assert.ok(prompt.includes('Direct dep full summary'));
    // Transitive dep should only have oneliner (not full summary)
    assert.ok(prompt.includes('Transitive dep oneliner'));
    assert.ok(!prompt.includes('Transitive dep full summary'));
  });

  it('orders: memory, snapshots, then task prompt', () => {
    const prompt = buildPrompt({
      template: 'TASK_HERE',
      context: {},
      snapshots: [makeSnapshot()],
      memoryContext: 'MEMORY_HERE',
    });

    const memIdx = prompt.indexOf('MEMORY_HERE');
    const snapIdx = prompt.indexOf('Predecessor Context');
    const taskIdx = prompt.indexOf('TASK_HERE');

    assert.ok(memIdx < snapIdx, 'memory should come before snapshots');
    assert.ok(snapIdx < taskIdx, 'snapshots should come before task');
  });

  it('respects maxContextChars budget', () => {
    const longSummary = 'x'.repeat(5000);
    const snap = makeSnapshot({ summary: longSummary });

    const prompt = buildPrompt({
      template: 'Task: test',
      context: {},
      snapshots: [snap],
      maxContextChars: 100,
    });

    // Should truncate or drop the snapshot
    assert.ok(prompt.length < 5000);
  });
});
