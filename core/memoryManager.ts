/**
 * Manages .dagclaw/memory/ — distilled knowledge from run logs.
 * Reads memory for context injection, writes memory after distillation.
 */

import fs from 'node:fs';
import path from 'node:path';

export class MemoryManager {
  private workDir: string;

  constructor(workDir: string) {
    this.workDir = workDir;
  }

  private memoryDir(): string {
    return path.join(this.workDir, '.dagclaw', 'memory');
  }

  /** Read all markdown memory files, concatenated with headers. */
  readAll(): string {
    const dir = this.memoryDir();
    if (!fs.existsSync(dir)) return '';

    const files = this.listFiles();
    if (files.length === 0) return '';

    const parts: string[] = [];
    for (const file of files) {
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
