import { useState, useEffect } from 'react';
import { useOrchestratorStore } from '../stores/orchestratorStore.ts';
import { PlanView } from './PlanView.tsx';
import { ApprovalBanner } from './ApprovalBanner.tsx';
import { ExecutionView } from './ExecutionView.tsx';
import { VerifyView } from './VerifyView.tsx';
import { StageIndicator } from './StageIndicator.tsx';
import { ActivityTimeline } from './ActivityTimeline.tsx';
import { CostDisplay } from './CostDisplay.tsx';

export function DetailPanel() {
  const selectedNodeId = useOrchestratorStore((state) => state.selectedNodeId);
  const task = useOrchestratorStore((state) =>
    state.selectedNodeId ? state.nodeMap.get(state.selectedNodeId) : undefined
  );
  const plan = useOrchestratorStore((state) =>
    state.selectedNodeId ? state.plans.get(state.selectedNodeId) : undefined
  );
  const verification = useOrchestratorStore((state) =>
    state.selectedNodeId ? state.verifications.get(state.selectedNodeId) : undefined
  );
  const stageInfo = useOrchestratorStore((state) =>
    state.selectedNodeId ? state.stageInfo.get(state.selectedNodeId) : undefined
  );
  const eventCount = useOrchestratorStore((state) =>
    state.selectedNodeId ? (state.events.get(state.selectedNodeId)?.length ?? 0) : 0
  );
  const usage = useOrchestratorStore((state) =>
    state.selectedNodeId ? state.usage.get(state.selectedNodeId) : undefined
  );
  const fetchUsage = useOrchestratorStore((state) => state.fetchUsage);

  const [activityOpen, setActivityOpen] = useState(false);

  useEffect(() => {
    if (selectedNodeId && task?.status === 'completed' && !usage) {
      fetchUsage(selectedNodeId);
    }
  }, [selectedNodeId, task?.status, usage, fetchUsage]);

  if (!selectedNodeId) {
    return (
      <div className="flex-1 bg-gray-900 overflow-y-auto p-4 flex items-center justify-center text-gray-500">
        Select a task to view details
      </div>
    );
  }

  const hasPendingApproval = task?.hasPendingApproval ?? false;
  const currentStage = stageInfo?.currentStage ?? '';
  const taskStatus = task?.status ?? 'pending';

  function renderContent() {
    // Plan stage or pending approval → PlanView
    if (currentStage === 'Plan' || hasPendingApproval) {
      return <PlanView taskId={selectedNodeId!} />;
    }

    // Execute stage
    if (currentStage === 'Execute') {
      return <ExecutionView taskId={selectedNodeId!} />;
    }

    // Verify stage or has verification result
    if (currentStage === 'Verify' || verification) {
      return <VerifyView taskId={selectedNodeId!} />;
    }

    // Default: task summary
    return (
      <div className="bg-gray-800 rounded p-4 space-y-3">
        {task ? (
          <>
            <div>
              <span className="text-gray-400 text-sm">Prompt:</span>
              <p className="text-white text-sm mt-1">{task.prompt}</p>
            </div>
            <div>
              <span className="text-gray-400 text-sm">Working Directory:</span>
              <p className="text-white text-sm mt-1 font-mono">{task.workDir}</p>
            </div>
            {plan && (
              <div className="pt-2 border-t border-gray-700">
                <PlanView taskId={selectedNodeId!} />
              </div>
            )}
          </>
        ) : (
          <p className="text-gray-400 text-sm">Loading task details...</p>
        )}
      </div>
    );
  }

  return (
    <div className="flex-1 bg-gray-900 overflow-y-auto flex flex-col">
      {/* Header bar with status and stage indicator */}
      <div className="px-4 py-3 border-b border-gray-800 shrink-0">
        <div className="flex items-center gap-3">
          <span className={`text-sm font-medium capitalize ${
            taskStatus === 'completed' ? 'text-green-400' :
            taskStatus === 'failed' ? 'text-red-400' :
            taskStatus === 'running' ? 'text-blue-400' :
            taskStatus === 'awaiting_approval' ? 'text-yellow-400' :
            'text-gray-400'
          }`}>
            {taskStatus === 'awaiting_approval' ? 'Awaiting Approval' : taskStatus}
          </span>
          {stageInfo && (
            <div className="flex-1 max-w-xs">
              <StageIndicator
                currentStage={stageInfo.currentStage}
                status={taskStatus === 'completed' ? 'completed' : taskStatus === 'failed' ? 'failed' : stageInfo.status}
              />
            </div>
          )}
          {selectedNodeId && (
            <div className="ml-auto">
              <CostDisplay taskId={selectedNodeId} />
            </div>
          )}
        </div>
      </div>

      {/* Error banner */}
      {task?.error && (
        <div className="mx-4 mt-3 p-3 bg-red-900/40 border border-red-700 rounded text-sm text-red-300">
          <span className="font-medium text-red-200">Error:</span> {task.error}
        </div>
      )}

      {/* Main content */}
      <div className="flex-1 overflow-y-auto p-4">
        {renderContent()}
      </div>

      {/* Activity Timeline */}
      {selectedNodeId && eventCount > 0 && (
        <div className="border-t border-gray-800 shrink-0">
          <button
            onClick={() => setActivityOpen(!activityOpen)}
            className="w-full px-4 py-2 flex items-center justify-between text-sm text-gray-400 hover:text-gray-200 hover:bg-gray-800/50 transition-colors"
          >
            <span className="flex items-center gap-2">
              <span className={`transform transition-transform ${activityOpen ? 'rotate-90' : ''}`}>▶</span>
              Activity
            </span>
            <span className="bg-gray-700 text-gray-300 text-xs px-2 py-0.5 rounded-full">
              {eventCount}
            </span>
          </button>
          {activityOpen && (
            <div className="px-4 pb-3">
              <ActivityTimeline taskId={selectedNodeId} />
            </div>
          )}
        </div>
      )}

      {/* Approval banner */}
      {hasPendingApproval && task?.pendingApprovalMessage && (
        <ApprovalBanner
          taskId={selectedNodeId}
          message={task.pendingApprovalMessage}
        />
      )}
    </div>
  );
}
