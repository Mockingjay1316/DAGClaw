import { useMemo } from 'react';
import { useOrchestratorStore, KANBAN_COLUMNS } from '../stores/orchestratorStore.ts';
import { useProjectStore } from '../stores/projectStore.ts';
import { KanbanColumn } from './KanbanColumn.tsx';
import type { TaskSummary } from '../types.ts';

export function KanbanBoard() {
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId);
  const rootTasks = useOrchestratorStore((s) => s.rootTasks);

  const grouped = useMemo(() => {
    if (!selectedProjectId) return {};
    const tasks = rootTasks.filter(t => t.projectId === selectedProjectId);
    const groups: Record<string, TaskSummary[]> = {};
    for (const col of KANBAN_COLUMNS) {
      let colTasks = tasks.filter(t => col.statuses.includes(t.status));
      // Sort each column appropriately
      if (col.key === 'todo' || col.key === 'review') {
        // Oldest first by createdAt
        colTasks = [...colTasks].sort((a, b) => {
          const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
          const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
          return aTime - bTime;
        });
      } else if (col.key === 'queued') {
        // By task number (execution order)
        colTasks = [...colTasks].sort((a, b) => {
          return (a.taskNumber ?? Infinity) - (b.taskNumber ?? Infinity);
        });
      } else if (col.key === 'running') {
        // Earliest started first
        colTasks = [...colTasks].sort((a, b) => {
          const aTime = (a.startedAt ?? a.createdAt) ? new Date(a.startedAt ?? a.createdAt!).getTime() : 0;
          const bTime = (b.startedAt ?? b.createdAt) ? new Date(b.startedAt ?? b.createdAt!).getTime() : 0;
          return aTime - bTime;
        });
      } else if (col.key === 'done' || col.key === 'failed') {
        // Newest finished first
        colTasks = [...colTasks].sort((a, b) => {
          const aTime = a.finishedAt ? new Date(a.finishedAt).getTime() : 0;
          const bTime = b.finishedAt ? new Date(b.finishedAt).getTime() : 0;
          return bTime - aTime;
        });
      }
      groups[col.key] = colTasks;
    }
    return groups;
  }, [rootTasks, selectedProjectId]);

  if (!selectedProjectId) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-500 text-sm">
        Select a project to view tasks
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-x-auto overflow-y-hidden p-3">
      <div className="flex gap-3 h-full min-w-min">
        {KANBAN_COLUMNS.map((col) => (
          <KanbanColumn
            key={col.key}
            columnKey={col.key}
            label={col.label}
            tasks={grouped[col.key] || []}
          />
        ))}
      </div>
    </div>
  );
}
