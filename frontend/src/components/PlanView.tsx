import { useOrchestratorStore } from '../stores/orchestratorStore.ts';
import type { Subtask } from '../types.ts';

interface PlanViewProps {
  taskId: string;
}

const complexityColors: Record<Subtask['estimatedComplexity'], string> = {
  low: 'bg-green-600 text-green-100',
  medium: 'bg-yellow-600 text-yellow-100',
  high: 'bg-red-600 text-red-100',
};

export function PlanView({ taskId }: PlanViewProps) {
  const plan = useOrchestratorStore((state) => state.plans.get(taskId));

  if (!plan) {
    return (
      <div className="flex items-center justify-center p-8 text-gray-400">
        <svg
          className="animate-spin h-5 w-5 mr-3 text-gray-400"
          viewBox="0 0 24 24"
          fill="none"
        >
          <circle
            className="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            strokeWidth="4"
          />
          <path
            className="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
          />
        </svg>
        Waiting for plan...
      </div>
    );
  }

  return (
    <div className="bg-gray-800 rounded p-4 space-y-4">
      <h2 className="text-lg font-semibold text-white whitespace-pre-wrap">{plan.summary}</h2>

      {plan.qualityFlag && (
        <div className="bg-yellow-900/50 border border-yellow-700 rounded p-3 text-sm text-yellow-200">
          <span className="font-medium capitalize">{plan.qualityFlag.concern}:</span>{' '}
          {plan.qualityFlag.message}
          {plan.qualityFlag.suggestion && (
            <p className="mt-1 text-yellow-300 text-xs">{plan.qualityFlag.suggestion}</p>
          )}
        </div>
      )}

      <ul className="space-y-2">
        {plan.subtasks.map((subtask) => (
          <li
            key={subtask.index}
            className="bg-gray-700/50 rounded p-3 text-sm"
          >
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-gray-400 font-mono text-xs">#{subtask.index}</span>
              <span className="text-white flex-1">{subtask.description}</span>
              <span
                className={`text-xs px-2 py-0.5 rounded font-medium ${complexityColors[subtask.estimatedComplexity]}`}
              >
                {subtask.estimatedComplexity}
              </span>
              {subtask.needsRecursiveDecomposition && (
                <span className="text-xs px-2 py-0.5 rounded bg-purple-600 text-purple-100 font-medium">
                  recursive
                </span>
              )}
              {subtask.stage && (
                <span className="text-xs px-2 py-0.5 rounded bg-blue-600 text-blue-100 font-medium">
                  {subtask.stage}
                </span>
              )}
            </div>
            {subtask.dependencies.length > 0 && (
              <div className="mt-1 text-xs text-gray-400">
                Depends on: {subtask.dependencies.join(', ')}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
