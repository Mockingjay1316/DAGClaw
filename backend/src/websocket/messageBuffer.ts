/**
 * Per-node ring buffer for WebSocket messages.
 * Uses a circular array to bound memory usage.
 */
export class MessageBuffer {
  private buffer: unknown[];
  private head: number = 0;
  private count: number = 0;
  private readonly maxSize: number;

  constructor(maxSize: number = 1000) {
    this.maxSize = maxSize;
    this.buffer = new Array(maxSize);
  }

  /** Adds a message to the buffer, evicting the oldest if at capacity. */
  push(message: unknown): void {
    const index = (this.head + this.count) % this.maxSize;
    if (this.count < this.maxSize) {
      this.buffer[index] = message;
      this.count++;
    } else {
      // At capacity — overwrite oldest and advance head
      this.buffer[this.head] = message;
      this.head = (this.head + 1) % this.maxSize;
    }
  }

  /** Returns all messages in insertion order. */
  getAll(): unknown[] {
    const result: unknown[] = [];
    for (let i = 0; i < this.count; i++) {
      result.push(this.buffer[(this.head + i) % this.maxSize]);
    }
    return result;
  }

  /** Empties the buffer. */
  clear(): void {
    this.head = 0;
    this.count = 0;
    this.buffer = new Array(this.maxSize);
  }

  /** Returns current buffer size. */
  get size(): number {
    return this.count;
  }
}
