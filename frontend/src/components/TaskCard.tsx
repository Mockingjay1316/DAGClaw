import { useOrchestratorStore } from '../stores/orchestratorStore.ts';
import { useWebSocket } from '../hooks/useWebSocket.ts';
import type { TaskSummary, TaskStatus } from '../types.ts';
import { CostDisplay } from './CostDisplay.tsx';

const statusColors: Record<string, string> = {
  todo: 'border-l-gray-500',
  queued: 'border-l-yellow-600',
  running: 'border-l-blue-500',
  awaiting_approval: 'border-l-yellow-500',
  pending: 'border-l-yellow-500',
  completed: 'border-l-green-500',
  failed: 'border-l-red-500',
  cancelled: 'border-l-gray-500',
};

const statusDots: Record<string, string> = {
  todo: 'bg-gray-500',
  queued: 'bg-yellow-600',
  running: 'bg-blue-500 animate-pulse',
  awaiting_approval: 'bg-yellow-500 animate-pulse',
  pending: 'bg-yellow-500',
  completed: 'bg-green-500',
  failed: 'bg-red-500',
  cancelled: 'bg-gray-500',
};

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + '\u2026' : text;
}

interface TaskCardProps {
  task: TaskSummary;
}

export function TaskCard({ task }: TaskCardProps) {
  const selectedNodeId = useOrchestratorStore((s) => s.selectedNodeId);
  const selectRoot = useOrchestratorStore((s) => s.selectRoot);
  const addRootTask = useOrchestratorStore((s) => s.addRootTask);
  const { subscribe } = useWebSocket();

  const isSelected = selectedNodeId === task.id;
  const stageInfo = useOrchestratorStore((s) => s.stageInfo.get(task.id));

  function handleClick() {
    selectRoot(task.id);
    subscribe([task.id]);
  }

  async function handleExecute(e: React.MouseEvent) {
    e.stopPropagation();
    try {
      const res = await fetch(`/api/tasks/${task.id}/execute`, { method: 'POST' });
      if (res.ok) {
        subscribe([task.id]);
      }
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
        subscribe([newId]);
      }
    } catch {
      // Ignore
    }
  }

  return (
    <div
      onClick={handleClick}
      className={`border-l-[3px] px-3 py-2 rounded-r bg-gray-800 hover:bg-gray-700 cursor-pointer transition-colors ${
        statusColors[task.status] || 'border-l-gray-500'
      } ${isSelected ? 'ring-1 ring-blue-500 bg-gray-700' : ''}`}
    >
      <div className="flex items-start gap-2">
        <span className={`w-2 h-2 rounded-full shrink-0 mt-1 ${statusDots[task.status] || 'bg-gray-500'}`} />
        <div className="flex-1 min-w-0">
          <p className="text-sm text-gray-200 truncate">{truncate(task.prompt, 80)}</p>
          <div className="flex items-center gap-2 mt-1">
            {stageInfo && (
              <span className="text-xs text-gray-500">{stageInfo.currentStage}</span>
            )}
            {task.status === 'completed' && (
              <CostDisplay taskId={task.id} compact />
            )}
          </div>
        </div>
        <div className="shrink-0 flex gap-1">
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
      </div>
    </div>
  );
}
