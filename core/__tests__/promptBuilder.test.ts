import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { interpolateTemplate } from '../promptBuilder.ts';

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
