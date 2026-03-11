/**
 * FIFO task scheduler that limits concurrent task execution.
 * Tasks are enqueued and drained up to MAX_CONCURRENT_TASKS.
 */
export class TaskScheduler {
  private queue: string[] = [];
  private running = new Set<string>();
  private maxConcurrent: number;
  private startCallback: ((taskId: string) => Promise<void>) | null = null;

  constructor(maxConcurrent?: number) {
    this.maxConcurrent = maxConcurrent ?? parseInt(process.env.CLAW_MAX_TASKS || '5', 10);
  }

  /** Set the callback that starts a task. Called by drain(). */
  onStart(cb: (taskId: string) => Promise<void>): void {
    this.startCallback = cb;
  }

  /** Add a task to the queue and trigger drain. */
  enqueue(taskId: string): void {
    this.queue.push(taskId);
    this.drain();
  }

  /** Mark a task as finished and trigger drain. */
  onTaskFinished(taskId: string): void {
    this.running.delete(taskId);
    this.drain();
  }

  /** Start tasks from the queue while under the concurrency limit. */
  private drain(): void {
    while (this.running.size < this.maxConcurrent && this.queue.length > 0) {
      const taskId = this.queue.shift()!;
      this.running.add(taskId);
      // Start in background — don't await
      this.startCallback?.(taskId).catch((err) => {
        console.error(`[scheduler] Failed to start task ${taskId}:`, err);
        this.running.delete(taskId);
        this.drain();
      });
    }
  }

  /** Get current queue length. */
  get queueLength(): number {
    return this.queue.length;
  }

  /** Get number of currently running tasks. */
  get runningCount(): number {
    return this.running.size;
  }

  /** Check if a task is in the queue. */
  isQueued(taskId: string): boolean {
    return this.queue.includes(taskId);
  }

  /** Check if a task is currently running. */
  isRunning(taskId: string): boolean {
    return this.running.has(taskId);
  }

  /** Remove a task from the queue (before it starts). Returns true if removed. */
  dequeue(taskId: string): boolean {
    const idx = this.queue.indexOf(taskId);
    if (idx === -1) return false;
    this.queue.splice(idx, 1);
    return true;
  }
}
