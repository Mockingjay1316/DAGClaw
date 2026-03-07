import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MessageBuffer } from '../src/websocket/messageBuffer.ts';

describe('MessageBuffer', () => {
  it('push and getAll return messages in order', () => {
    const buf = new MessageBuffer();
    buf.push('a');
    buf.push('b');
    buf.push('c');
    assert.deepStrictEqual(buf.getAll(), ['a', 'b', 'c']);
  });

  it('ring buffer overflow: only last maxSize items remain in order', () => {
    const buf = new MessageBuffer(3);
    buf.push(1);
    buf.push(2);
    buf.push(3);
    buf.push(4);
    buf.push(5);
    // pushed 5 items into size-3 buffer, last 3 should remain
    assert.deepStrictEqual(buf.getAll(), [3, 4, 5]);
    assert.equal(buf.size, 3);
  });

  it('clear empties the buffer and size returns 0', () => {
    const buf = new MessageBuffer();
    buf.push('x');
    buf.push('y');
    assert.equal(buf.size, 2);
    buf.clear();
    assert.equal(buf.size, 0);
    assert.deepStrictEqual(buf.getAll(), []);
  });

  it('custom maxSize works', () => {
    const buf = new MessageBuffer(2);
    buf.push('a');
    buf.push('b');
    assert.equal(buf.size, 2);
    buf.push('c');
    assert.equal(buf.size, 2);
    assert.deepStrictEqual(buf.getAll(), ['b', 'c']);
  });

  it('getAll on empty buffer returns []', () => {
    const buf = new MessageBuffer();
    assert.deepStrictEqual(buf.getAll(), []);
    assert.equal(buf.size, 0);
  });
});
