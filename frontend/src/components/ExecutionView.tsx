import { useOrchestratorStore } from '../stores/orchestratorStore.ts';
import { SubtaskTerminal } from './SubtaskTerminal.tsx';

interface ExecutionViewProps {
  taskId: string;
}

export function ExecutionView({ taskId }: ExecutionViewProps) {
  const plan = useOrchestratorStore((state) => state.plans.get(taskId));
  const subtaskStatuses = useOrchestratorStore((state) => state.subtaskStatuses.get(taskId));

  if (!plan) {
    return (
      <div className="text-gray-400 p-4">
        No plan available for execution view.
      </div>
    );
  }

  const subtasks = plan.subtasks;
  const total = subtasks.length;
  const completed = subtasks.filter((st) => {
    const status = subtaskStatuses?.get(st.index);
    return status === 'completed';
  }).length;

  const gridCols = total <= 2 ? 'grid-cols-1' : 'grid-cols-1 md:grid-cols-2';

  return (
    <div className="flex flex-col gap-4 overflow-y-auto p-4">
      {/* Progress bar */}
      <div className="flex items-center gap-3">
        <span className="text-sm text-gray-300 font-medium">
          Execution Progress: {completed}/{total} subtasks completed
        </span>
        <div className="flex-1 h-2 bg-gray-700 rounded-full overflow-hidden">
          <div
            className="h-full bg-green-500 transition-all duration-300"
            style={{ width: total > 0 ? `${(completed / total) * 100}%` : '0%' }}
          />
        </div>
      </div>

      {/* Subtask terminal grid */}
      <div className={`grid ${gridCols} gap-4`}>
        {subtasks.map((subtask) => (
          <SubtaskTerminal
            key={subtask.index}
            taskId={taskId}
            subtaskIndex={subtask.index}
            description={subtask.description}
          />
        ))}
      </div>
    </div>
  );
}
