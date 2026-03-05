import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { MemoryManager } from '../memoryManager.ts';

let tmpDir: string;

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

    it('reads all markdown files from .claw/memory/', () => {
      const memDir = path.join(tmpDir, '.claw', 'memory');
      fs.mkdirSync(memDir, { recursive: true });
      fs.writeFileSync(path.join(memDir, 'codebase.md'), '# Codebase\nUses Express.');
      fs.writeFileSync(path.join(memDir, 'patterns.md'), '# Patterns\nUse async/await.');

      const mm = new MemoryManager(tmpDir);
      const content = mm.readAll();
      assert.ok(content.includes('# Codebase'));
      assert.ok(content.includes('# Patterns'));
    });

    it('ignores non-markdown files', () => {
      const memDir = path.join(tmpDir, '.claw', 'memory');
      fs.mkdirSync(memDir, { recursive: true });
      fs.writeFileSync(path.join(memDir, 'notes.md'), '# Notes');
      fs.writeFileSync(path.join(memDir, 'data.json'), '{}');

      const mm = new MemoryManager(tmpDir);
      const content = mm.readAll();
      assert.ok(content.includes('# Notes'));
      assert.ok(!content.includes('{}'));
    });
  });

  describe('readFile', () => {
    it('reads a specific memory file', () => {
      const memDir = path.join(tmpDir, '.claw', 'memory');
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

      const filePath = path.join(tmpDir, '.claw', 'memory', 'codebase.md');
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
      const memDir = path.join(tmpDir, '.claw', 'memory');
      fs.mkdirSync(memDir, { recursive: true });
      fs.writeFileSync(path.join(memDir, 'a.md'), 'a');
      fs.writeFileSync(path.join(memDir, 'b.md'), 'b');
      fs.writeFileSync(path.join(memDir, 'c.json'), '{}');

      const mm = new MemoryManager(tmpDir);
      assert.deepEqual(mm.listFiles().sort(), ['a.md', 'b.md']);
    });
  });

  describe('buildContextBlock', () => {
    it('returns empty string when no memory', () => {
      const mm = new MemoryManager(tmpDir);
      assert.equal(mm.buildContextBlock(), '');
    });

    it('wraps content in section markers', () => {
      const memDir = path.join(tmpDir, '.claw', 'memory');
      fs.mkdirSync(memDir, { recursive: true });
      fs.writeFileSync(path.join(memDir, 'test.md'), 'content here');

      const mm = new MemoryManager(tmpDir);
      const block = mm.buildContextBlock();
      assert.ok(block.includes('--- Project Memory ---'));
      assert.ok(block.includes('content here'));
    });

    it('respects maxChars budget', () => {
      const memDir = path.join(tmpDir, '.claw', 'memory');
      fs.mkdirSync(memDir, { recursive: true });
      fs.writeFileSync(path.join(memDir, 'big.md'), 'x'.repeat(1000));

      const mm = new MemoryManager(tmpDir);
      const block = mm.buildContextBlock(100);
      assert.ok(block.length <= 150); // some overhead for markers
    });
  });
});
