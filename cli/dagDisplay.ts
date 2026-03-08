/**
 * Live DAG status display for terminal output.
 * TTY: renders running/waiting lines in a mutable zone, overwrites them in-place.
 *      Completed/failed/skipped and external status lines are printed permanently above.
 * Non-TTY: prints state-change lines sequentially.
 */

import type { DAGEvent } from '../core/types.ts';

// --- Elapsed time formatting ---

/** Format elapsed ms as human-readable: "45s", "3m 24s", "1h 05m 30s". */
export function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const hours = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  if (hours > 0) {
    return `${hours}h ${mins.toString().padStart(2, '0')}m ${secs.toString().padStart(2, '0')}s`;
  }
  return `${mins}m ${secs.toString().padStart(2, '0')}s`;
}

// --- ANSI-aware line truncation ---

/** Count visible (non-ANSI) characters in a string. */
export function visibleLength(str: string): number {
  // Strip ANSI escape sequences
  return str.replace(/\x1b\[[0-9;]*m/g, '').length;
}

/** Max visible characters for subtask descriptions in display output. */
const DESC_MAX_LEN = 40;

/**
 * Truncate a plain text description to maxLen visible characters.
 * Appends '...' when truncated.
 */
export function truncateDesc(desc: string, maxLen: number = DESC_MAX_LEN): string {
  if (desc.length <= maxLen) return desc;
  return desc.slice(0, maxLen) + '...';
}

interface DisplayEntry {
  index: number;
  description: string;
  stage: string;
  state: 'waiting' | 'running' | 'completed' | 'failed' | 'skipped';
  startTime?: number;
  elapsed?: number;
  result?: string;
  dependencies: number[];
  cascadeFrom?: number;
}

export class DagDisplay {
  private entries: Map<number, DisplayEntry> = new Map();
  private stream: NodeJS.WritableStream & { isTTY?: boolean };
  private isTTY: boolean;
  private timer: ReturnType<typeof setInterval> | null = null;
  // TTY: count of mutable lines (running + waiting) written at bottom
  private mutableLineCount = 0;
  // Non-TTY: track last printed state per subtask
  private lastNonTTYState: Map<number, string> = new Map();
  // Non-TTY: track last printed elapsed second per subtask (avoids duplicate prints)
  private lastPrintedSecond: Map<number, number> = new Map();
  // Whether DAG is active
  private active = false;
  // Standalone stage ticker (Plan, Verify, etc.)
  private stageLabel: string | null = null;
  private stageStartTime: number | null = null;
  private stageTimer: ReturnType<typeof setInterval> | null = null;
  private stageLastPrintedSecond = -1;

  constructor(stream: NodeJS.WritableStream & { isTTY?: boolean }) {
    this.stream = stream;
    this.isTTY = !!stream.isTTY;
  }

  handleEvent(event: DAGEvent): void {
    switch (event.type) {
      case 'dag-start':
        this.active = true;
        for (const st of event.subtasks) {
          this.entries.set(st.index, {
            index: st.index,
            description: st.description,
            stage: st.stage,
            state: 'waiting',
            dependencies: st.dependencies,
          });
        }
        this.startTimer();
        this.render();
        break;

      case 'subtask-started': {
        const entry = this.entries.get(event.index);
        if (entry) {
          entry.state = 'running';
          entry.startTime = Date.now();
        }
        this.render();
        break;
      }

      case 'subtask-completed': {
        const entry = this.entries.get(event.index);
        if (entry) {
          entry.state = 'completed';
          entry.elapsed = event.elapsed;
          entry.result = event.oneliner;
        }
        this.render();
        break;
      }

      case 'subtask-failed': {
        const entry = this.entries.get(event.index);
        if (entry) {
          entry.state = 'failed';
          entry.elapsed = event.elapsed;
          entry.result = event.error;
        }
        this.render();
        break;
      }

      case 'subtask-skipped': {
        const entry = this.entries.get(event.index);
        if (entry) {
          entry.state = 'skipped';
          entry.cascadeFrom = event.cascadeFrom;
        }
        this.render();
        break;
      }

      case 'dag-complete':
        this.finalize();
        break;
    }
  }

  /**
   * Write an external status line while the DAG display is active.
   * In TTY mode: clears the mutable zone, prints the line permanently, re-renders mutable zone.
   * In non-TTY mode: prints the line directly.
   */
  writeStatus(line: string): void {
    if (this.isTTY && this.active) {
      this.eraseMutableZone();
      this.stream.write(line + '\n');
      this.writeMutableZone();
    } else {
      this.stream.write(line + '\n');
    }
  }

  /** Whether the DAG display is currently active (DAG or standalone stage). */
  isActive(): boolean {
    return this.active || this.stageLabel !== null;
  }

  /** Start a live elapsed-time ticker for a standalone stage (Plan, Verify, etc.). */
  stageStart(label: string): void {
    this.stageLabel = label;
    this.stageStartTime = Date.now();
    this.stageLastPrintedSecond = -1;
    this.renderStageLine();
    this.stageTimer = setInterval(() => {
      if (!this.stageLabel) return;
      this.renderStageLine();
    }, 500);
    if (this.stageTimer && typeof this.stageTimer === 'object' && 'unref' in this.stageTimer) {
      this.stageTimer.unref();
    }
  }

  /** Stop the standalone stage ticker. */
  stageEnd(): void {
    if (this.stageTimer) {
      clearInterval(this.stageTimer);
      this.stageTimer = null;
    }
    if (this.isTTY && this.stageLabel) {
      // Erase the mutable stage line
      this.eraseMutableZone();
    }
    this.stageLabel = null;
    this.stageStartTime = null;
    this.mutableLineCount = 0;
  }

  private renderStageLine(): void {
    const elapsed = this.stageStartTime ? Date.now() - this.stageStartTime : 0;
    const sec = Math.round(elapsed / 1000);
    const line = `${this.stageLabel} (${formatElapsed(elapsed)})`;

    if (this.isTTY) {
      this.eraseMutableZone();
      this.stream.write(line + '\n');
      this.mutableLineCount = 1;
    } else {
      // Non-TTY: only print when second changes
      if (sec !== this.stageLastPrintedSecond) {
        this.stageLastPrintedSecond = sec;
        this.stream.write(line + '\n');
      }
    }
  }

  finalize(): void {
    this.active = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.isTTY) {
      // Clear mutable zone and print remaining entries that haven't been permanently printed
      this.eraseMutableZone();
      for (const entry of this.sortedEntries()) {
        if (entry.state !== 'waiting' && !this.printedIndices.has(entry.index)) {
          this.printedIndices.add(entry.index);
          this.stream.write(this.formatEntry(entry) + '\n');
        }
      }
      this.mutableLineCount = 0;
    }
  }

  private startTimer(): void {
    this.timer = setInterval(() => {
      if (!this.active) return;
      const hasRunning = [...this.entries.values()].some(e => e.state === 'running');
      if (!hasRunning) return;

      if (this.isTTY) {
        this.eraseMutableZone();
        this.writeMutableZone();
      } else {
        // Non-TTY: reprint running lines only when the displayed second changes
        for (const entry of this.sortedEntries()) {
          if (entry.state === 'running' && entry.startTime) {
            const nowSec = Math.round((Date.now() - entry.startTime) / 1000);
            const prevSec = this.lastPrintedSecond.get(entry.index);
            if (prevSec !== nowSec) {
              this.lastPrintedSecond.set(entry.index, nowSec);
              this.stream.write(this.formatEntry(entry) + '\n');
            }
          }
        }
      }
    }, 500);
    // Don't let the timer keep the process alive
    if (this.timer && typeof this.timer === 'object' && 'unref' in this.timer) {
      this.timer.unref();
    }
  }

  private render(): void {
    if (this.isTTY) {
      this.renderTTY();
    } else {
      this.renderNonTTY();
    }
  }

  // --- Non-TTY: simple log lines on state changes ---

  private renderNonTTY(): void {
    for (const entry of this.sortedEntries()) {
      const prev = this.lastNonTTYState.get(entry.index);
      if (prev !== entry.state) {
        this.lastNonTTYState.set(entry.index, entry.state);
        if (entry.state !== 'waiting') {
          this.stream.write(this.formatEntry(entry) + '\n');
        }
      }
    }

    // Print waiting line — only for subtasks with actual unmet dependencies
    const blocked = this.getBlockedEntries();
    if (blocked.length > 0) {
      const parts = blocked.map(e => {
        const unmet = this.unmetDeps(e);
        return `[${e.index}] blocked on [${unmet.join(', ')}]`;
      });
      this.stream.write(`  Waiting: ${parts.join(', ')}\n`);
    }
  }

  // --- TTY rendering ---

  // Track which entries have been permanently printed
  private printedIndices = new Set<number>();

  private renderTTY(): void {
    // Erase previous mutable zone
    this.eraseMutableZone();

    // Print newly completed/failed/skipped entries as permanent lines (only once)
    for (const entry of this.sortedEntries()) {
      const isFinal = entry.state === 'completed' || entry.state === 'failed' || entry.state === 'skipped';
      if (isFinal && !this.printedIndices.has(entry.index)) {
        this.printedIndices.add(entry.index);
        this.stream.write(this.formatEntry(entry) + '\n');
      }
    }

    // Write mutable zone (running + blocked)
    this.writeMutableZone();
  }

  /** Erase the mutable zone (running + waiting lines at the bottom). */
  private eraseMutableZone(): void {
    if (this.mutableLineCount > 0) {
      this.stream.write(`\x1b[${this.mutableLineCount}A`);
      for (let i = 0; i < this.mutableLineCount; i++) {
        this.stream.write('\x1b[2K\n');
      }
      this.stream.write(`\x1b[${this.mutableLineCount}A`);
      this.mutableLineCount = 0;
    }
  }

  /** Write the mutable zone: running lines + blocked/waiting line. */
  private writeMutableZone(): void {
    let count = 0;

    for (const entry of this.sortedEntries()) {
      if (entry.state === 'running') {
        this.stream.write(this.formatEntry(entry) + '\n');
        count++;
      }
    }

    const blocked = this.getBlockedEntries();
    if (blocked.length > 0) {
      const parts = blocked.map(e => {
        const unmet = this.unmetDeps(e);
        return `[${e.index}] blocked on [${unmet.join(', ')}]`;
      });
      this.stream.write(`  Waiting: ${parts.join(', ')}\n`);
      count++;
    }

    this.mutableLineCount = count;
  }

  private formatEntry(entry: DisplayEntry): string {
    const tag = `[${entry.stage}]`;
    const idx = `[${entry.index}]`;
    const desc = truncateDesc(entry.description);

    switch (entry.state) {
      case 'completed':
        return `${tag} ${idx} ${desc} -- done (${formatElapsed(entry.elapsed ?? 0)})`;
      case 'failed':
        return `${tag} ${idx} ${desc} -- FAILED (${formatElapsed(entry.elapsed ?? 0)})`;
      case 'skipped':
        return `${tag} ${idx} ${desc} -- skipped (cascade from ${entry.cascadeFrom})`;
      case 'running': {
        const elapsed = entry.startTime ? Date.now() - entry.startTime : 0;
        return `${tag} ${idx} ${desc} -- running... (${formatElapsed(elapsed)})`;
      }
      case 'waiting':
        return `${tag} ${idx} ${desc} -- waiting`;
    }
  }

  /** Subtasks that are waiting AND have at least one unmet dependency. */
  private getBlockedEntries(): DisplayEntry[] {
    return this.sortedEntries().filter(e => {
      if (e.state !== 'waiting') return false;
      return e.dependencies.some(d => {
        const dep = this.entries.get(d);
        return dep && dep.state !== 'completed';
      });
    });
  }

  /** Get unmet dependency indices for an entry. */
  private unmetDeps(entry: DisplayEntry): number[] {
    return entry.dependencies.filter(d => {
      const dep = this.entries.get(d);
      return dep && dep.state !== 'completed';
    });
  }

  private sortedEntries(): DisplayEntry[] {
    return [...this.entries.values()].sort((a, b) => a.index - b.index);
  }
}
