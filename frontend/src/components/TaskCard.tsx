import { useOrchestratorStore } from '../stores/orchestratorStore.ts';
import type { TaskSummary } from '../types.ts';
import { CostDisplay } from './CostDisplay.tsx';
import { statusColors, statusDots, statusBgs } from '../utils/colors.ts';
import { truncate, formatElapsed } from '../utils/formatters.ts';

function formatFinishedTime(finishedAt?: string): string | null {
  if (!finishedAt) return null;
  const d = new Date(finishedAt);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  if (isToday) {
    return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

interface TaskCardProps {
  task: TaskSummary;
}

export function TaskCard({ task }: TaskCardProps) {
  const selectedNodeId = useOrchestratorStore((s) => s.selectedNodeId);
  const selectRoot = useOrchestratorStore((s) => s.selectRoot);
  const addRootTask = useOrchestratorStore((s) => s.addRootTask);

  const isSelected = selectedNodeId === task.id;
  const stageInfo = useOrchestratorStore((s) => s.stageInfo.get(task.id));

  function handleClick() {
    selectRoot(task.id);
  }

  async function handleExecute(e: React.MouseEvent) {
    e.stopPropagation();
    try {
      await fetch(`/api/tasks/${task.id}/execute`, { method: 'POST' });
    } catch {
      // Ignore
    }
  }

  async function handleRetry(e: React.MouseEvent) {
    e.stopPropagation();
    try {
      const res = await fetch(`/api/tasks/${task.id}/retry`, { method: 'POST' });
      if (res.ok) {
        const { id: newId } = await res.json();
        addRootTask({ id: newId, prompt: task.prompt, workDir: task.workDir, projectId: task.projectId, status: 'queued', runId: null });
      }
    } catch {
      // Ignore
    }
  }

  const hasButtons = task.status === 'todo' || task.status === 'failed' || task.status === 'cancelled';

  return (
    <div
      onClick={handleClick}
      className={`border-l-[3px] px-3 py-2.5 rounded-lg hover:bg-gray-700 cursor-pointer transition-colors ${
        statusColors[task.status] || 'border-l-gray-500'
      } ${statusBgs[task.status] || 'bg-gray-800'} ${isSelected ? 'ring-1 ring-blue-500 bg-gray-700' : ''}`}
    >
      {/* Task number */}
      {task.taskNumber != null && task.taskNumber > 0 && (
        <span className="inline-block text-[10px] text-gray-400 font-mono px-1.5 py-0.5 mb-1 rounded-full bg-gray-700/50 border border-gray-600/50">
          #{task.taskNumber}
        </span>
      )}
      <div className="flex items-start gap-2">
        <span className={`w-2 h-2 rounded-full shrink-0 mt-1 ${statusDots[task.status] || 'bg-gray-500'}`} />
        <div className="flex-1 min-w-0">
          <p className="text-sm text-gray-200 line-clamp-3">{task.prompt}</p>
          <div className="flex items-center gap-2 mt-1">
            {stageInfo && task.status !== 'completed' && task.status !== 'failed' && task.status !== 'cancelled' && (
              <span className="text-xs text-gray-500">{stageInfo.currentStage}</span>
            )}
          </div>
        </div>
      </div>
      {(task.finishedAt || task.status === 'completed' || task.status === 'failed') && (
        <div className="flex items-center gap-2 mt-1 text-xs text-gray-500">
          {task.finishedAt && <span>{formatFinishedTime(task.finishedAt)}</span>}
          {formatElapsed(task.startedAt, task.finishedAt) && (
            <span>• {formatElapsed(task.startedAt, task.finishedAt)}</span>
          )}
          {(task.status === 'completed' || task.status === 'failed') && (
            <span className="ml-auto"><CostDisplay taskId={task.id} compact /></span>
          )}
        </div>
      )}
      {hasButtons && (
        <div className="flex justify-end gap-1 mt-2">
          {task.status === 'todo' && (
            <button
              onClick={handleExecute}
              className="px-2 py-0.5 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors cursor-pointer"
            >
              Run
            </button>
          )}
          {(task.status === 'failed' || task.status === 'cancelled') && (
            <button
              onClick={handleRetry}
              className="px-2 py-0.5 text-xs bg-gray-600 hover:bg-gray-500 text-white rounded transition-colors cursor-pointer"
            >
              Retry
            </button>
          )}
        </div>
      )}
    </div>
  );
}
