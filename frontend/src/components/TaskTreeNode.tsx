import { useOrchestratorStore } from '../stores/orchestratorStore.ts';
import { StageIndicator } from './StageIndicator.tsx';

interface TaskTreeNodeProps {
  taskId: string;
  depth: number;
}

const COMPLEXITY_COLORS: Record<string, string> = {
  low: 'bg-green-700 text-green-200',
  medium: 'bg-yellow-700 text-yellow-200',
  high: 'bg-red-700 text-red-200',
};

const STATUS_DOT_COLORS: Record<string, string> = {
  pending: 'bg-gray-500',
  running: 'bg-blue-500 animate-pulse',
  completed: 'bg-green-500',
  failed: 'bg-red-500',
  skipped: 'bg-gray-400',
};

function truncate(text: string, maxLen: number): string {
  return text.length > maxLen ? text.slice(0, maxLen) + '\u2026' : text;
}

export function TaskTreeNode({ taskId, depth }: TaskTreeNodeProps) {
  const task = useOrchestratorStore((state) => state.nodeMap.get(taskId));
  const subtaskStatuses = useOrchestratorStore((state) => state.subtaskStatuses.get(taskId));
  const plan = useOrchestratorStore((state) => state.plans.get(taskId));
  const stageInfo = useOrchestratorStore((state) => state.stageInfo.get(taskId));
  const selectedNodeId = useOrchestratorStore((state) => state.selectedNodeId);
  const expanded = useOrchestratorStore((state) => state.expandedNodes.has(taskId));
  const toggleExpand = useOrchestratorStore((state) => state.toggleExpand);
  const selectNode = useOrchestratorStore((state) => state.selectNode);

  if (!task) return null;

  const hasSubtasks = plan && plan.subtasks.length > 0;
  const isSelected = selectedNodeId === taskId;
  const paddingLeft = depth * 16; // pl-{depth*4} equivalent in px (4 = 1rem = 16px)

  return (
    <div>
      {/* Main node row */}
      <div
        className={`flex items-center gap-2 px-2 py-1.5 cursor-pointer rounded transition-colors ${
          isSelected ? 'bg-blue-900/40 border-l-2 border-blue-400' : 'hover:bg-gray-800/50'
        }`}
        style={{ paddingLeft: `${paddingLeft + 8}px` }}
        onClick={() => selectNode(taskId)}
      >
        {/* Expand/collapse chevron */}
        {hasSubtasks ? (
          <button
            className="text-gray-400 hover:text-gray-200 w-4 shrink-0"
            onClick={(e) => {
              e.stopPropagation();
              toggleExpand(taskId);
            }}
          >
            {expanded ? '\u25BC' : '\u25B6'}
          </button>
        ) : (
          <span className="w-4 shrink-0" />
        )}

        {/* Task prompt */}
        <span className="text-sm text-gray-200 truncate flex-1" title={task.prompt}>
          {truncate(task.prompt, 60)}
        </span>

        {/* Stage indicator */}
        {stageInfo && (
          <div className="w-32 shrink-0">
            <StageIndicator
              currentStage={stageInfo.currentStage}
              status={stageInfo.status}
            />
          </div>
        )}

        {/* Status badge */}
        <span className="text-xs text-gray-400 shrink-0">{task.status}</span>
      </div>

      {/* Expanded subtask list */}
      {expanded && hasSubtasks && (
        <div style={{ paddingLeft: `${paddingLeft + 32}px` }}>
          {plan.subtasks.map((subtask) => {
            const subtaskStatus = subtaskStatuses?.get(subtask.index) ?? 'pending';
            const dotColor = STATUS_DOT_COLORS[subtaskStatus] ?? 'bg-gray-500';
            const complexityClass = COMPLEXITY_COLORS[subtask.estimatedComplexity] ?? '';

            return (
              <div
                key={subtask.index}
                className="flex items-center gap-2 px-2 py-1 text-sm text-gray-300"
              >
                {/* Status dot */}
                <span className={`w-2 h-2 rounded-full shrink-0 ${dotColor}`} />

                {/* Index */}
                <span className="text-gray-500 w-5 shrink-0 text-right">
                  {subtask.index}
                </span>

                {/* Description */}
                <span className="truncate flex-1" title={subtask.description}>
                  {truncate(subtask.description, 50)}
                </span>

                {/* Complexity badge */}
                <span className={`text-xs px-1.5 py-0.5 rounded ${complexityClass}`}>
                  {subtask.estimatedComplexity}
                </span>

                {/* Dependencies */}
                {subtask.dependencies.length > 0 && (
                  <span className="text-xs text-gray-500" title={`Depends on: ${subtask.dependencies.join(', ')}`}>
                    dep: {subtask.dependencies.join(',')}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
