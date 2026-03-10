import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { MemoryManager } from '../memoryManager.ts';

let tmpDir: string;

// Standard structured memory file for testing
const STRUCTURED_MEMORY = `# Added REST API Routes

> Implemented CRUD endpoints for tasks using Express router factory pattern and TDD.

## Summary

Added four REST endpoints for task management. Used the router factory pattern to capture workDir in closure. All routes follow the try/catch 404 pattern for missing resources. Six tests written before implementation guided the API shape. The discriminated union for WebSocket messages made adding the usage_update variant straightforward.

## Key Patterns

### Express Router Factory
Use createRouter(workDir) factory functions so workDir is captured in closure.

## Gotchas

Shared timestamps in test fixtures caused non-deterministic sort order.

## Reusable Insights

1. Factory pattern for routers with dependencies.
2. Real filesystem fixtures > mocks for integration tests.
`;

describe('MemoryManager', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-mem-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('readAll', () => {
    it('returns empty string when no memory dir', () => {
      const mm = new MemoryManager(tmpDir);
      assert.equal(mm.readAll(), '');
    });

    it('reads all markdown files from .dagclaw/memory/', () => {
      const memDir = path.join(tmpDir, '.dagclaw', 'memory');
      fs.mkdirSync(memDir, { recursive: true });
      fs.writeFileSync(path.join(memDir, 'codebase.md'), '# Codebase\nUses Express.');
      fs.writeFileSync(path.join(memDir, 'patterns.md'), '# Patterns\nUse async/await.');

      const mm = new MemoryManager(tmpDir);
      const content = mm.readAll();
      assert.ok(content.includes('# Codebase'));
      assert.ok(content.includes('# Patterns'));
    });

    it('ignores non-markdown files', () => {
      const memDir = path.join(tmpDir, '.dagclaw', 'memory');
      fs.mkdirSync(memDir, { recursive: true });
      fs.writeFileSync(path.join(memDir, 'notes.md'), '# Notes');
      fs.writeFileSync(path.join(memDir, 'data.json'), '{}');

      const mm = new MemoryManager(tmpDir);
      const content = mm.readAll();
      assert.ok(content.includes('# Notes'));
      assert.ok(!content.includes('{}'));
    });

    it('puts index.md first when it exists', () => {
      const memDir = path.join(tmpDir, '.dagclaw', 'memory');
      fs.mkdirSync(memDir, { recursive: true });
      fs.writeFileSync(path.join(memDir, 'zzz.md'), 'zzz content');
      fs.writeFileSync(path.join(memDir, 'index.md'), 'INDEX CONTENT');

      const mm = new MemoryManager(tmpDir);
      const content = mm.readAll();
      const indexPos = content.indexOf('INDEX CONTENT');
      const zzzPos = content.indexOf('zzz content');
      assert.ok(indexPos < zzzPos, 'index.md should appear before other files');
    });
  });

  describe('readFile', () => {
    it('reads a specific memory file', () => {
      const memDir = path.join(tmpDir, '.dagclaw', 'memory');
      fs.mkdirSync(memDir, { recursive: true });
      fs.writeFileSync(path.join(memDir, 'errors.md'), '# Errors\nFix timeout.');

      const mm = new MemoryManager(tmpDir);
      const content = mm.readFile('errors.md');
      assert.equal(content, '# Errors\nFix timeout.');
    });

    it('returns null for non-existent file', () => {
      const mm = new MemoryManager(tmpDir);
      assert.equal(mm.readFile('nope.md'), null);
    });
  });

  describe('writeFile', () => {
    it('creates memory directory and writes file', () => {
      const mm = new MemoryManager(tmpDir);
      mm.writeFile('codebase.md', '# Codebase\nNew info.');

      const filePath = path.join(tmpDir, '.dagclaw', 'memory', 'codebase.md');
      assert.ok(fs.existsSync(filePath));
      assert.equal(fs.readFileSync(filePath, 'utf-8'), '# Codebase\nNew info.');
    });

    it('overwrites existing file', () => {
      const mm = new MemoryManager(tmpDir);
      mm.writeFile('test.md', 'first');
      mm.writeFile('test.md', 'second');

      assert.equal(mm.readFile('test.md'), 'second');
    });
  });

  describe('listFiles', () => {
    it('returns empty array when no memory dir', () => {
      const mm = new MemoryManager(tmpDir);
      assert.deepEqual(mm.listFiles(), []);
    });

    it('returns markdown filenames', () => {
      const memDir = path.join(tmpDir, '.dagclaw', 'memory');
      fs.mkdirSync(memDir, { recursive: true });
      fs.writeFileSync(path.join(memDir, 'a.md'), 'a');
      fs.writeFileSync(path.join(memDir, 'b.md'), 'b');
      fs.writeFileSync(path.join(memDir, 'c.json'), '{}');

      const mm = new MemoryManager(tmpDir);
      assert.deepEqual(mm.listFiles().sort(), ['a.md', 'b.md']);
    });
  });

  describe('readSummaries', () => {
    it('returns empty array when no memory dir', () => {
      const mm = new MemoryManager(tmpDir);
      assert.deepEqual(mm.readSummaries(), []);
    });

    it('parses structured memory files into entries', () => {
      const memDir = path.join(tmpDir, '.dagclaw', 'memory');
      fs.mkdirSync(memDir, { recursive: true });
      fs.writeFileSync(path.join(memDir, 'run-001.md'), STRUCTURED_MEMORY);

      const mm = new MemoryManager(tmpDir);
      const entries = mm.readSummaries();

      assert.equal(entries.length, 1);
      assert.equal(entries[0].filename, 'run-001.md');
      assert.equal(entries[0].title, 'Added REST API Routes');
      assert.equal(entries[0].oneliner, 'Implemented CRUD endpoints for tasks using Express router factory pattern and TDD.');
      assert.ok(entries[0].summary.includes('Added four REST endpoints'));
      assert.ok(entries[0].summary.includes('discriminated union'));
    });

    it('excludes index.md', () => {
      const memDir = path.join(tmpDir, '.dagclaw', 'memory');
      fs.mkdirSync(memDir, { recursive: true });
      fs.writeFileSync(path.join(memDir, 'index.md'), '# Index\n> old index');
      fs.writeFileSync(path.join(memDir, 'run-001.md'), STRUCTURED_MEMORY);

      const mm = new MemoryManager(tmpDir);
      const entries = mm.readSummaries();
      assert.equal(entries.length, 1);
      assert.equal(entries[0].filename, 'run-001.md');
    });

    it('falls back to first content line when no blockquote exists', () => {
      const memDir = path.join(tmpDir, '.dagclaw', 'memory');
      fs.mkdirSync(memDir, { recursive: true });
      fs.writeFileSync(path.join(memDir, 'legacy.md'), '# Old Format\n\nSome plain content without blockquote.');

      const mm = new MemoryManager(tmpDir);
      const entries = mm.readSummaries();
      assert.equal(entries[0].oneliner, 'Some plain content without blockquote.');
    });

    it('truncates fallback one-liner to 150 chars', () => {
      const memDir = path.join(tmpDir, '.dagclaw', 'memory');
      fs.mkdirSync(memDir, { recursive: true });
      fs.writeFileSync(path.join(memDir, 'long.md'), '# Title\n\n' + 'A'.repeat(200));

      const mm = new MemoryManager(tmpDir);
      const entries = mm.readSummaries();
      assert.ok(entries[0].oneliner.length <= 150);
      assert.ok(entries[0].oneliner.endsWith('...'));
    });
  });

  describe('updateIndex', () => {
    it('generates three-column markdown table', () => {
      const memDir = path.join(tmpDir, '.dagclaw', 'memory');
      fs.mkdirSync(memDir, { recursive: true });
      fs.writeFileSync(path.join(memDir, 'run-001.md'), STRUCTURED_MEMORY);

      const mm = new MemoryManager(tmpDir);
      mm.updateIndex();

      const index = fs.readFileSync(path.join(memDir, 'index.md'), 'utf-8');
      assert.ok(index.includes('# DAGClaw Project Memory Index'));
      assert.ok(index.includes('| Run | Title | Summary |'));
      assert.ok(index.includes('[run-001.md](run-001.md)'));
      assert.ok(index.includes('Added REST API Routes'));
      assert.ok(index.includes('Implemented CRUD endpoints'));
    });

    it('excludes index.md from the listing', () => {
      const memDir = path.join(tmpDir, '.dagclaw', 'memory');
      fs.mkdirSync(memDir, { recursive: true });
      fs.writeFileSync(path.join(memDir, 'notes.md'), '# Notes\n\nSome notes here.');
      fs.writeFileSync(path.join(memDir, 'index.md'), 'old index content');

      const mm = new MemoryManager(tmpDir);
      mm.updateIndex();

      const index = fs.readFileSync(path.join(memDir, 'index.md'), 'utf-8');
      assert.ok(!index.includes('[index.md]'));
      assert.ok(index.includes('[notes.md](notes.md)'));
    });

    it('handles legacy files without blockquote gracefully', () => {
      const memDir = path.join(tmpDir, '.dagclaw', 'memory');
      fs.mkdirSync(memDir, { recursive: true });
      fs.writeFileSync(path.join(memDir, 'legacy.md'), '# Old Title\n\nPlain content here.');

      const mm = new MemoryManager(tmpDir);
      mm.updateIndex();

      const index = fs.readFileSync(path.join(memDir, 'index.md'), 'utf-8');
      assert.ok(index.includes('Old Title'));
      assert.ok(index.includes('Plain content here.'));
    });
  });

  describe('buildContextBlock', () => {
    it('returns empty string when no memory', () => {
      const mm = new MemoryManager(tmpDir);
      assert.equal(mm.buildContextBlock(), '');
    });

    it('wraps content in section markers', () => {
      const memDir = path.join(tmpDir, '.dagclaw', 'memory');
      fs.mkdirSync(memDir, { recursive: true });
      fs.writeFileSync(path.join(memDir, 'test.md'), 'content here');

      const mm = new MemoryManager(tmpDir);
      const block = mm.buildContextBlock();
      assert.ok(block.includes('--- Project Memory ---'));
      assert.ok(block.includes('content here'));
    });

    it('respects maxChars budget', () => {
      const memDir = path.join(tmpDir, '.dagclaw', 'memory');
      fs.mkdirSync(memDir, { recursive: true });
      fs.writeFileSync(path.join(memDir, 'big.md'), 'x'.repeat(1000));

      const mm = new MemoryManager(tmpDir);
      const block = mm.buildContextBlock(100);
      assert.ok(block.length <= 150); // some overhead for markers
    });

    it('includes index before detail files', () => {
      const memDir = path.join(tmpDir, '.dagclaw', 'memory');
      fs.mkdirSync(memDir, { recursive: true });
      fs.writeFileSync(path.join(memDir, 'details.md'), 'Detailed info here.');
      fs.writeFileSync(path.join(memDir, 'index.md'), 'Memory Index Table');

      const mm = new MemoryManager(tmpDir);
      const block = mm.buildContextBlock();
      const indexPos = block.indexOf('Memory Index Table');
      const detailPos = block.indexOf('Detailed info here.');
      assert.ok(indexPos >= 0, 'should include index content');
      assert.ok(detailPos >= 0, 'should include detail content');
      assert.ok(indexPos < detailPos, 'index should appear before details');
    });
  });
});
