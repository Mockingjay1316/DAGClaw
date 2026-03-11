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
}

export function KanbanColumn({ columnKey, label, tasks }: KanbanColumnProps) {
  const accent = columnAccents[columnKey] || 'border-t-gray-500';
  const isEmpty = tasks.length === 0;

  return (
    <div className={`flex flex-col min-w-[200px] flex-1 border-t-2 ${accent} bg-gray-900/50 rounded-t`}>
      {/* Header */}
      <div className="px-3 py-2 flex items-center justify-between">
        <h3 className="text-sm font-medium text-gray-300">{label}</h3>
        {tasks.length > 0 && (
          <span className="bg-gray-700 text-gray-300 text-xs px-2 py-0.5 rounded-full">
            {tasks.length}
          </span>
        )}
      </div>

      {/* Card list */}
      {!isEmpty && (
        <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-1.5 max-h-[calc(100vh-200px)]">
          {tasks.map((task) => (
            <TaskCard key={task.id} task={task} />
          ))}
        </div>
      )}
    </div>
  );
}
