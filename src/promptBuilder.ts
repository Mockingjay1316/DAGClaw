/**
 * Prompt construction: template interpolation, snapshot formatting, prompt assembly.
 * Cache-optimized ordering: memory → snapshots → task prompt.
 */

import type { ContextSnapshot } from './types.ts';

/** Replace {{placeholders}} in template with context values. */
export function interpolateTemplate(
  template: string,
  context: Record<string, string>
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    return key in context ? context[key] : match;
  });
}

/** Format a snapshot in compact tier (oneliner + files, ~50 tokens). */
export function formatSnapshotCompact(snap: ContextSnapshot): string {
  const label = snap.subtaskIndex !== undefined
    ? `[${snap.stage} #${snap.subtaskIndex}]`
    : `[${snap.stage}]`;
  return `${label} ${snap.oneliner} (files: ${snap.filesModified.join(', ') || 'none'})`;
}

/** Format a snapshot in standard tier (full summary + files, ~200 tokens). */
export function formatSnapshotStandard(snap: ContextSnapshot): string {
  const label = snap.subtaskIndex !== undefined
    ? `[${snap.stage} #${snap.subtaskIndex}]`
    : `[${snap.stage}]`;
  return `${label} ${snap.summary}\nFiles: ${snap.filesModified.join(', ') || 'none'}`;
}

