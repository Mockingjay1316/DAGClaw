import { useMemo, useCallback } from 'react';
import { useOrchestratorStore, KANBAN_COLUMNS } from '../stores/orchestratorStore.ts';
import { useProjectStore } from '../stores/projectStore.ts';
import { KanbanColumn } from './KanbanColumn.tsx';
import type { TaskSummary } from '../types.ts';

export function KanbanBoard() {
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId);
  const rootTasks = useOrchestratorStore((s) => s.rootTasks);
  const columnCounts = useOrchestratorStore((s) => s.columnCounts);
  const appendTasks = useOrchestratorStore((s) => s.appendTasks);

  const grouped = useMemo(() => {
    if (!selectedProjectId) return {};
    const tasks = rootTasks.filter(t => t.projectId === selectedProjectId);
    const groups: Record<string, TaskSummary[]> = {};
    for (const col of KANBAN_COLUMNS) {
      let colTasks = tasks.filter(t => col.statuses.includes(t.status));
      // Sort each column appropriately
      if (col.key === 'todo' || col.key === 'review') {
        colTasks = [...colTasks].sort((a, b) => {
          const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
          const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
          return aTime - bTime;
        });
      } else if (col.key === 'queued') {
        colTasks = [...colTasks].sort((a, b) => {
          return (a.taskNumber ?? Infinity) - (b.taskNumber ?? Infinity);
        });
      } else if (col.key === 'running') {
        colTasks = [...colTasks].sort((a, b) => {
          const aTime = (a.startedAt ?? a.createdAt) ? new Date(a.startedAt ?? a.createdAt!).getTime() : 0;
          const bTime = (b.startedAt ?? b.createdAt) ? new Date(b.startedAt ?? b.createdAt!).getTime() : 0;
          return aTime - bTime;
        });
      } else if (col.key === 'done' || col.key === 'failed') {
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

  // Compute totalCount per column from columnCounts
  const columnTotals = useMemo(() => {
    const totals: Record<string, number> = {};
    for (const col of KANBAN_COLUMNS) {
      totals[col.key] = col.statuses.reduce((sum, s) => sum + (columnCounts[s] || 0), 0);
    }
    return totals;
  }, [columnCounts]);

  const handleLoadMore = useCallback(async (columnKey: string) => {
    const col = KANBAN_COLUMNS.find(c => c.key === columnKey);
    if (!col || !selectedProjectId) return;
    const currentTasks = grouped[columnKey] || [];
    for (const status of col.statuses) {
      const statusCount = currentTasks.filter(t => t.status === status).length;
      const resp = await fetch(`/api/projects/${selectedProjectId}/tasks?status=${status}&limit=5&offset=${statusCount}`);
      if (resp.ok) {
        const data = await resp.json();
        if (data.tasks) {
          appendTasks(data.tasks);
        }
      }
    }
  }, [selectedProjectId, grouped, appendTasks]);

  if (!selectedProjectId) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-500 text-sm">
        Select a project to view tasks
      </div>
    );
  }

  return (
    <div className="h-full overflow-x-auto overflow-y-hidden p-3">
      <div className="flex gap-2 h-full">
        {KANBAN_COLUMNS.map((col) => (
          <KanbanColumn
            key={col.key}
            columnKey={col.key}
            label={col.label}
            tasks={grouped[col.key] || []}
            totalCount={columnTotals[col.key]}
            onLoadMore={() => handleLoadMore(col.key)}
          />
        ))}
      </div>
    </div>
  );
}
