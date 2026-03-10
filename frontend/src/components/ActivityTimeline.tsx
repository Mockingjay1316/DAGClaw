import type { TimelineEvent } from '../types.ts';
import { useOrchestratorStore } from '../stores/orchestratorStore.ts';

// --- Relative timestamp helper ---

function relativeTime(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
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
            {relativeTime(event.timestamp)}
          </span>
          {/* Message */}
          <span className="text-gray-300">{event.message}</span>
        </div>
      ))}
    </div>
  );
}
