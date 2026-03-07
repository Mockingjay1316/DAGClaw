import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { DagDisplay } from '../dagDisplay.ts';
import type { DAGEvent } from '../../core/types.ts';

/** Create a mock writable stream that captures output. */
function createMockStream(isTTY = true): Writable & { output: string; isTTY: boolean; columns: number } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  }) as Writable & { output: string; isTTY: boolean; columns: number };
  stream.isTTY = isTTY;
  stream.columns = 80;
  Object.defineProperty(stream, 'output', {
    get: () => chunks.join(''),
  });
  return stream;
}

function makeSubtasks() {
  return [
    { index: 0, description: 'Set up Express routes', dependencies: [], stage: 'Execute' },
    { index: 1, description: 'Implement WebSocket', dependencies: [0], stage: 'Execute' },
    { index: 2, description: 'Wire up task manager', dependencies: [0], stage: 'Execute' },
    { index: 3, description: 'Integration tests', dependencies: [1, 2], stage: 'Execute' },
  ];
}

describe('DagDisplay', () => {
  describe('basic lifecycle', () => {
    it('renders dag-start with blocked subtasks in waiting line', () => {
      const stream = createMockStream(false);
      const display = new DagDisplay(stream);

      display.handleEvent({ type: 'dag-start', subtasks: makeSubtasks() });

      // Subtasks 1,2,3 have unmet deps so should appear in waiting line
      // Subtask 0 has no deps so should NOT appear in waiting line
      assert.ok(stream.output.includes('Waiting'));
      assert.ok(stream.output.includes('[1] blocked on'));
      assert.ok(!stream.output.includes('[0] blocked on'));
      display.finalize();
    });

    it('renders subtask-started', () => {
      const stream = createMockStream(false);
      const display = new DagDisplay(stream);

      display.handleEvent({ type: 'dag-start', subtasks: makeSubtasks() });
      display.handleEvent({ type: 'subtask-started', index: 0 });

      assert.ok(stream.output.includes('running'));
      display.finalize();
    });

    it('renders subtask-completed', () => {
      const stream = createMockStream(false);
      const display = new DagDisplay(stream);

      display.handleEvent({ type: 'dag-start', subtasks: makeSubtasks() });
      display.handleEvent({ type: 'subtask-started', index: 0 });
      display.handleEvent({ type: 'subtask-completed', index: 0, oneliner: 'Routes set up', elapsed: 12000 });

      assert.ok(stream.output.includes('done'));
      assert.ok(stream.output.includes('12s'));
      display.finalize();
    });

    it('renders dag-complete', () => {
      const stream = createMockStream(false);
      const display = new DagDisplay(stream);

      display.handleEvent({ type: 'dag-start', subtasks: makeSubtasks() });
      display.handleEvent({ type: 'subtask-started', index: 0 });
      display.handleEvent({ type: 'subtask-completed', index: 0, oneliner: 'Done', elapsed: 5000 });
      display.handleEvent({ type: 'dag-complete' });

      // Should not throw
      display.finalize();
    });
  });

  describe('concurrent subtasks', () => {
    it('shows multiple running subtasks', () => {
      const stream = createMockStream(false);
      const display = new DagDisplay(stream);

      display.handleEvent({ type: 'dag-start', subtasks: makeSubtasks() });
      display.handleEvent({ type: 'subtask-started', index: 0 });
      display.handleEvent({ type: 'subtask-completed', index: 0, oneliner: 'Done', elapsed: 5000 });
      display.handleEvent({ type: 'subtask-started', index: 1 });
      display.handleEvent({ type: 'subtask-started', index: 2 });

      assert.ok(stream.output.includes('[1]'));
      assert.ok(stream.output.includes('[2]'));
      assert.ok(stream.output.includes('running'));
      display.finalize();
    });
  });

  describe('failed + cascade skip', () => {
    it('renders failed subtask', () => {
      const stream = createMockStream(false);
      const display = new DagDisplay(stream);

      display.handleEvent({ type: 'dag-start', subtasks: makeSubtasks() });
      display.handleEvent({ type: 'subtask-started', index: 0 });
      display.handleEvent({ type: 'subtask-failed', index: 0, error: 'Timeout', elapsed: 8000 });

      assert.ok(stream.output.includes('FAILED'));
      assert.ok(stream.output.includes('8s'));
      display.finalize();
    });

    it('renders cascade skip', () => {
      const stream = createMockStream(false);
      const display = new DagDisplay(stream);

      display.handleEvent({ type: 'dag-start', subtasks: makeSubtasks() });
      display.handleEvent({ type: 'subtask-started', index: 0 });
      display.handleEvent({ type: 'subtask-failed', index: 0, error: 'Timeout', elapsed: 8000 });
      display.handleEvent({ type: 'subtask-skipped', index: 1, cascadeFrom: 0 });

      assert.ok(stream.output.includes('skipped'));
      assert.ok(stream.output.includes('cascade from 0'));
      display.finalize();
    });
  });

  describe('non-TTY fallback', () => {
    it('prints simple log lines without ANSI codes', () => {
      const stream = createMockStream(false);
      const display = new DagDisplay(stream);

      display.handleEvent({ type: 'dag-start', subtasks: makeSubtasks() });
      display.handleEvent({ type: 'subtask-started', index: 0 });
      display.handleEvent({ type: 'subtask-completed', index: 0, oneliner: 'Done', elapsed: 5000 });
      display.handleEvent({ type: 'dag-complete' });

      // No ANSI escape codes in non-TTY mode
      assert.ok(!stream.output.includes('\x1b['));
      display.finalize();
    });
  });

  describe('TTY mode', () => {
    it('uses ANSI codes for in-place updates', () => {
      const stream = createMockStream(true);
      const display = new DagDisplay(stream);

      display.handleEvent({ type: 'dag-start', subtasks: makeSubtasks() });
      display.handleEvent({ type: 'subtask-started', index: 0 });

      // First render has a running line, second render should use cursor-up to overwrite
      display.handleEvent({ type: 'subtask-completed', index: 0, oneliner: 'Done', elapsed: 5000 });

      // ANSI cursor-up code should be present (overwriting previous render)
      assert.ok(stream.output.includes('\x1b['));
      // The completed state should appear
      assert.ok(stream.output.includes('done'));
      display.finalize();
    });

    it('finalize prints all entries as permanent lines', () => {
      const stream = createMockStream(true);
      const display = new DagDisplay(stream);

      const subtasks = [
        { index: 0, description: 'Task A', dependencies: [], stage: 'Execute' },
        { index: 1, description: 'Task B', dependencies: [0], stage: 'Execute' },
      ];
      display.handleEvent({ type: 'dag-start', subtasks });
      display.handleEvent({ type: 'subtask-started', index: 0 });
      display.handleEvent({ type: 'subtask-completed', index: 0, oneliner: 'Done A', elapsed: 3000 });
      display.handleEvent({ type: 'subtask-started', index: 1 });
      display.handleEvent({ type: 'subtask-completed', index: 1, oneliner: 'Done B', elapsed: 2000 });
      display.handleEvent({ type: 'dag-complete' });

      // After finalize, both entries should appear as "done"
      // Split output to check the final lines (after last clear)
      const finalLines = stream.output.split('\n').filter(l => l.includes('done'));
      assert.ok(finalLines.length >= 2, `Expected at least 2 done lines, got ${finalLines.length}`);
    });
  });

  describe('writeStatus integration', () => {
    it('isActive returns true between dag-start and dag-complete', () => {
      const stream = createMockStream(false);
      const display = new DagDisplay(stream);

      assert.equal(display.isActive(), false);
      display.handleEvent({ type: 'dag-start', subtasks: makeSubtasks() });
      assert.equal(display.isActive(), true);
      display.handleEvent({ type: 'dag-complete' });
      assert.equal(display.isActive(), false);
    });

    it('writeStatus prints line in non-TTY mode', () => {
      const stream = createMockStream(false);
      const display = new DagDisplay(stream);

      display.handleEvent({ type: 'dag-start', subtasks: makeSubtasks() });
      display.writeStatus('External status message');

      assert.ok(stream.output.includes('External status message'));
      display.finalize();
    });

    it('writeStatus in TTY mode preserves mutable zone', () => {
      const stream = createMockStream(true);
      const display = new DagDisplay(stream);

      display.handleEvent({ type: 'dag-start', subtasks: makeSubtasks() });
      display.handleEvent({ type: 'subtask-started', index: 0 });

      // Write an external status while running
      display.writeStatus('Some other log line');

      // Should contain the status line and still have running content
      assert.ok(stream.output.includes('Some other log line'));
      assert.ok(stream.output.includes('running'));
      display.finalize();
    });
  });

  describe('stage ticker', () => {
    it('stageStart prints the label with elapsed time', () => {
      const stream = createMockStream(false);
      const display = new DagDisplay(stream);

      display.stageStart('[Plan] Running...');

      assert.ok(stream.output.includes('[Plan] Running...'));
      assert.ok(stream.output.includes('(0s)'));
      display.stageEnd();
    });

    it('isActive returns true during stage ticker', () => {
      const stream = createMockStream(false);
      const display = new DagDisplay(stream);

      assert.equal(display.isActive(), false);
      display.stageStart('[Verify] Running...');
      assert.equal(display.isActive(), true);
      display.stageEnd();
      assert.equal(display.isActive(), false);
    });

    it('stageEnd clears timer in TTY mode', () => {
      const stream = createMockStream(true);
      const display = new DagDisplay(stream);

      display.stageStart('[Plan] Running...');
      assert.ok(stream.output.includes('[Plan] Running...'));
      display.stageEnd();

      // After stageEnd, ANSI erase code should be present (clearing the mutable line)
      assert.ok(stream.output.includes('\x1b['));
    });
  });

  describe('waiting line', () => {
    it('shows blocked subtasks with their dependencies in non-TTY', () => {
      const stream = createMockStream(false);
      const display = new DagDisplay(stream);

      const subtasks = makeSubtasks();
      display.handleEvent({ type: 'dag-start', subtasks });
      display.handleEvent({ type: 'subtask-started', index: 0 });

      // Subtasks 1,2 blocked on [0], subtask 3 blocked on [1,2]
      assert.ok(stream.output.includes('Waiting') || stream.output.includes('blocked'));
      display.finalize();
    });

    it('does not show subtasks with no dependencies as blocked', () => {
      const stream = createMockStream(false);
      const display = new DagDisplay(stream);

      // All independent subtasks — no deps
      const subtasks = [
        { index: 0, description: 'Task A', dependencies: [], stage: 'Execute' },
        { index: 1, description: 'Task B', dependencies: [], stage: 'Execute' },
      ];
      display.handleEvent({ type: 'dag-start', subtasks });

      // No waiting line should appear since nothing is blocked
      assert.ok(!stream.output.includes('Waiting'));
      assert.ok(!stream.output.includes('blocked'));
      display.finalize();
    });
  });
});
