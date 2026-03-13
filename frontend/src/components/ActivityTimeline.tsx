import { useState, useEffect } from 'react';
import type { TimelineEvent } from '../types.ts';
import { useOrchestratorStore } from '../stores/orchestratorStore.ts';

// --- Dynamic relative timestamp ---

function relativeTime(timestamp: number, now: number): string {
  const ms = now - timestamp;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s ago`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

// --- Ticking clock hook ---

function useTickingClock(newestTimestamp: number | undefined): number {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!newestTimestamp) return;

    const getInterval = () => {
      const age = Date.now() - newestTimestamp;
      if (age < 10_000) return 100;
      if (age < 60_000) return 1_000;
      if (age < 3_600_000) return 60_000;
      return 3_600_000;
    };

    let timerId: ReturnType<typeof setTimeout>;
    const tick = () => {
      setNow(Date.now());
      timerId = setTimeout(tick, getInterval());
    };
    timerId = setTimeout(tick, getInterval());

    return () => clearTimeout(timerId);
  }, [newestTimestamp]);

  return now;
}

// --- Event dot color logic ---

type DotColor = 'bg-green-400' | 'bg-red-400' | 'bg-yellow-400' | 'bg-blue-400';

function getDotColor(event: TimelineEvent): DotColor {
  const { type, message } = event;

  // Success types
  if (
    type === 'task_complete' ||
    type === 'stage_complete' ||
    (type === 'subtask_complete' && !message.includes('failed')) ||
    (type === 'verification_result' && message.includes('passed'))
  ) {
    return 'bg-green-400';
  }

  // Error types
  if (
    type === 'task_error' ||
    message.includes('failed') ||
    message.includes('error')
  ) {
    return 'bg-red-400';
  }

  // Warning types
  if (type === 'approval_required' || type === 'approval_resolved') {
    return 'bg-yellow-400';
  }

  // Default: info
  return 'bg-blue-400';
}

// --- Component ---

interface ActivityTimelineProps {
  taskId: string;
}

export function ActivityTimeline({ taskId }: ActivityTimelineProps) {
  const events = useOrchestratorStore(
    (state) => (state as unknown as { events: Map<string, TimelineEvent[]> }).events?.get(taskId) ?? []
  );

  // Reverse-chronological: newest first
  const sorted = [...events].sort((a, b) => b.timestamp - a.timestamp);
  const newestTimestamp = sorted.length > 0 ? sorted[0].timestamp : undefined;
  const now = useTickingClock(newestTimestamp);

  if (sorted.length === 0) {
    return (
      <div className="text-xs text-gray-500 px-2 py-1">No activity yet.</div>
    );
  }

  return (
    <div className="max-h-64 overflow-y-auto space-y-1 bg-gray-900 rounded">
      {sorted.map((event, i) => (
        <div
          key={`${event.timestamp}-${event.type}-${i}`}
          className="flex items-center gap-2 py-1 px-2 text-xs"
        >
          {/* Colored dot */}
          <span
            className={`w-2 h-2 rounded-full shrink-0 ${getDotColor(event)}`}
          />
          {/* Relative timestamp */}
          <span className="text-gray-500 shrink-0 w-16">
            {relativeTime(event.timestamp, now)}
          </span>
          {/* Message */}
          <span className="text-gray-300">{event.message}</span>
        </div>
      ))}
    </div>
  );
}
