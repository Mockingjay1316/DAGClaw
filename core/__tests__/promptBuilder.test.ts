import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  interpolateTemplate,
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

