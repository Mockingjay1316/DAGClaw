/**
 * Manages .dagclaw/memory/ — distilled knowledge from run logs.
 * Reads memory for context injection, writes memory after distillation.
 *
 * Memory file format:
 *   # Human-Readable Title
 *   > One-line summary for index retrieval (max 150 chars)
 *   ## Summary
 *   100-200 word narrative...
 *   ## Key Patterns / ## Gotchas / ## Reusable Insights
 *   Detailed content...
 */

import fs from 'node:fs';
import path from 'node:path';

export interface MemoryEntry {
  filename: string;
  title: string;
  oneliner: string;
  summary: string;
}

export class MemoryManager {
  private workDir: string;

  constructor(workDir: string) {
    this.workDir = workDir;
  }

  private memoryDir(): string {
    return path.join(this.workDir, '.dagclaw', 'memory');
  }

  /** Read all markdown memory files, concatenated with headers. index.md appears first. */
  readAll(): string {
    const dir = this.memoryDir();
    if (!fs.existsSync(dir)) return '';

    const files = this.listFiles();
    if (files.length === 0) return '';

    // Limit to 10 most recent non-index files to avoid context explosion
    const nonIndex = files.filter((f) => f !== 'index.md');
    const recent = nonIndex.slice(-10);
    const hasIndex = files.includes('index.md');
    const sorted = hasIndex ? ['index.md', ...recent] : recent;

    const parts: string[] = [];
    for (const file of sorted) {
      const content = fs.readFileSync(path.join(dir, file), 'utf-8');
      parts.push(`### ${file}\n${content}`);
    }
    return parts.join('\n\n');
  }

  /** Read a specific memory file. Returns null if not found. */
  readFile(filename: string): string | null {
    const filePath = path.join(this.memoryDir(), filename);
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath, 'utf-8');
  }

  /** Write (create or overwrite) a memory file. */
  writeFile(filename: string, content: string): void {
    const dir = this.memoryDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, filename), content);
  }

  /** List markdown filenames in memory directory. */
  listFiles(): string[] {
    const dir = this.memoryDir();
    if (!fs.existsSync(dir)) return [];

    return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
  }

  /**
   * Parse structured metadata from all memory files.
   * Returns entries with title, one-liner, and summary section for retrieval.
   * Excludes index.md.
   */
  readSummaries(): MemoryEntry[] {
    const dir = this.memoryDir();
    if (!fs.existsSync(dir)) return [];

    const files = this.listFiles().filter((f) => f !== 'index.md');
    const entries: MemoryEntry[] = [];

    for (const file of files) {
      const content = fs.readFileSync(path.join(dir, file), 'utf-8');
      entries.push({
        filename: file,
        ...this.parseMemoryFile(content),
      });
    }

    return entries;
  }

  /**
   * Parse a memory file into structured parts: title, one-liner, summary.
   * Expected format:
   *   # Title
   *   > One-liner for index
   *   ## Summary
   *   Narrative paragraph...
   */
  private parseMemoryFile(content: string): { title: string; oneliner: string; summary: string } {
    const lines = content.split('\n');
    let title = '';
    let oneliner = '';
    let summary = '';
    let inSummary = false;
    const summaryLines: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();

      // Extract H1 title
      if (trimmed.startsWith('# ') && !title) {
        title = trimmed.slice(2).trim();
        continue;
      }

      // Extract blockquote one-liner
      if (trimmed.startsWith('> ') && !oneliner && title) {
        oneliner = trimmed.slice(2).trim();
        continue;
      }

      // Track ## Summary section
      if (/^## Summary/i.test(trimmed)) {
        inSummary = true;
        continue;
      }

      // End summary at next ## heading
      if (inSummary && trimmed.startsWith('## ')) {
        inSummary = false;
        continue;
      }

      if (inSummary && trimmed) {
        summaryLines.push(trimmed);
      }
    }

    summary = summaryLines.join(' ');

    // Fallback: if no blockquote, use first non-heading, non-empty line
    if (!oneliner) {
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('>')) continue;
        oneliner = trimmed.length > 150 ? trimmed.slice(0, 147) + '...' : trimmed;
        break;
      }
    }

    return { title, oneliner, summary };
  }

  /** Regenerate index.md summarizing all memory files. */
  updateIndex(): void {
    const dir = this.memoryDir();
    if (!fs.existsSync(dir)) return;

    const entries = this.readSummaries();
    const lines: string[] = [
      '# DAGClaw Project Memory Index',
      '',
      '| Run | Title | Summary |',
      '|-----|-------|---------|',
    ];

    for (const entry of entries) {
      const displayTitle = entry.title || entry.filename;
      const displaySummary = entry.oneliner || '(no summary)';
      lines.push(`| [${entry.filename}](${entry.filename}) | ${displayTitle} | ${displaySummary} |`);
    }

    fs.writeFileSync(path.join(dir, 'index.md'), lines.join('\n') + '\n');
  }

  /** Build a context block for prompt injection. Respects optional char budget. */
  buildContextBlock(maxChars?: number): string {
    const raw = this.readAll();
    if (!raw) return '';

    const header = '--- Project Memory ---\n';
    const footer = '\n--- End Memory ---';

    let content = raw;
    if (maxChars !== undefined) {
      const budget = maxChars - header.length - footer.length;
      if (budget <= 0) return '';
      content = raw.slice(0, budget);
    }

    return `${header}${content}${footer}`;
  }
}
