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

export interface BuildPromptOptions {
  template: string;
  context: Record<string, string>;
  snapshots?: ContextSnapshot[];
  memoryContext?: string;
  directIndices?: Set<number>;
  maxContextChars?: number;
}

/**
 * Build the full prompt from template, context, snapshots, and memory.
 * Ordering: memory → predecessor snapshots → task prompt (cache-optimized).
 */
export function buildPrompt(options: BuildPromptOptions): string {
  const {
    template,
    context,
    snapshots = [],
    memoryContext = '',
    directIndices,
    maxContextChars,
  } = options;

  const interpolated = interpolateTemplate(template, context);
  const parts: string[] = [];

  // 1. Memory context (shared prefix for caching)
  if (memoryContext) {
    parts.push(memoryContext);
  }

  // 2. Predecessor context snapshots
  if (snapshots.length > 0) {
    const snapshotBlock = formatSnapshots(snapshots, directIndices, maxContextChars);
    if (snapshotBlock) {
      parts.push(snapshotBlock);
    }
  }

  // 3. Task-specific prompt
  parts.push(interpolated);

  return parts.join('\n\n');
}

function formatSnapshots(
  snapshots: ContextSnapshot[],
  directIndices?: Set<number>,
  maxChars?: number
): string {
  const header = '--- Predecessor Context ---';
  const footer = '--- End Predecessor Context ---';
  const lines: string[] = [header];

  for (const snap of snapshots) {
    const isDirect = !directIndices
      || snap.subtaskIndex === undefined
      || directIndices.has(snap.subtaskIndex);

    const formatted = isDirect
      ? formatSnapshotStandard(snap)
      : formatSnapshotCompact(snap);

    lines.push(formatted);
  }

  lines.push(footer);

  const block = lines.join('\n');

  // If over budget, truncate (drop from the beginning — transitive deps first)
  if (maxChars !== undefined && block.length > maxChars) {
    // Simple truncation: just use as much as fits
    return block.slice(0, maxChars);
  }

  return block;
}
