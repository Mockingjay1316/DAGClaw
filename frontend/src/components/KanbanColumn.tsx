import { useState, useCallback } from 'react';
import type { TaskSummary } from '../types.ts';
import { TaskCard } from './TaskCard.tsx';

const columnAccents: Record<string, string> = {
  todo: 'border-t-gray-500',
  queued: 'border-t-yellow-600',
  review: 'border-t-yellow-500',
  running: 'border-t-blue-500',
  failed: 'border-t-red-500',
  done: 'border-t-green-500',
};

interface KanbanColumnProps {
  columnKey: string;
  label: string;
  tasks: TaskSummary[];
  totalCount?: number;
  onLoadMore?: () => void;
}

export function KanbanColumn({ columnKey, label, tasks, totalCount, onLoadMore }: KanbanColumnProps) {
  const accent = columnAccents[columnKey] || 'border-t-gray-500';
  const [visibleCount, setVisibleCount] = useState(10);
  const displayCount = totalCount ?? tasks.length;
  const visibleTasks = tasks.slice(0, visibleCount);
  const isEmpty = tasks.length === 0 && displayCount === 0;
  const remaining = displayCount - Math.min(visibleCount, tasks.length);

  const handleLoadMore = useCallback(() => {
    if (visibleCount < tasks.length) {
      // Reveal already-loaded-but-hidden cards
      setVisibleCount(v => v + 5);
    } else if (onLoadMore) {
      // Fetch more from server, then reveal
      onLoadMore();
      setVisibleCount(v => v + 5);
    }
  }, [visibleCount, tasks.length, onLoadMore]);

  return (
    <div className={`flex flex-col flex-1 min-w-[140px] min-h-0 border-t-2 ${accent} bg-gray-900/50 rounded-t`}>
      {/* Header */}
      <div className="px-3 py-2 flex items-center justify-between">
        <h3 className="text-sm font-medium text-gray-300">{label}</h3>
        {displayCount > 0 && (
          <span className="bg-gray-700 text-gray-300 text-xs px-2 py-0.5 rounded-full">
            {displayCount}
          </span>
        )}
      </div>

      {/* Card list */}
      {isEmpty ? (
        <div className="px-2 pb-2">
          <div className="border-l-[3px] border-l-gray-600 px-3 py-4 rounded-r bg-gray-800 flex items-center justify-center">
            <span className="text-xs text-gray-500">No Task</span>
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-1.5">
          {visibleTasks.map((task) => (
            <TaskCard key={task.id} task={task} />
          ))}
          {remaining > 0 && (
            <button
              onClick={handleLoadMore}
              className="w-full border-l-[3px] border-l-gray-600 px-3 py-3 rounded-r bg-gray-800
                         hover:bg-gray-700 cursor-pointer transition-colors text-center"
            >
              <span className="text-xs text-gray-400">+{remaining} more</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
