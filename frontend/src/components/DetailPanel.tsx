import { useState, useEffect } from 'react';
import { useOrchestratorStore } from '../stores/orchestratorStore.ts';
import { cancelTask as cancelTaskApi } from '../api/tasks.ts';
import { PlanView } from './PlanView.tsx';
import { ApprovalBanner } from './ApprovalBanner.tsx';
import { ExecutionView } from './ExecutionView.tsx';
import { VerifyView } from './VerifyView.tsx';
import { StageIndicator } from './StageIndicator.tsx';
import { ActivityTimeline } from './ActivityTimeline.tsx';
import { CostDisplay } from './CostDisplay.tsx';

export function DetailPanel() {
  const selectedNodeId = useOrchestratorStore((state) => state.selectedNodeId);
  const selectNode = useOrchestratorStore((state) => state.selectNode);
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
  const fetchEvents = useOrchestratorStore((state) => state.fetchEvents);
  const fetchUsage = useOrchestratorStore((state) => state.fetchUsage);
  const fetchPlan = useOrchestratorStore((state) => state.fetchPlan);
  const fetchVerification = useOrchestratorStore((state) => state.fetchVerification);

  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const updateTaskStatus = useOrchestratorStore((state) => state.updateTaskStatus);
  const addRootTask = useOrchestratorStore((state) => state.addRootTask);
  const selectRoot = useOrchestratorStore((state) => state.selectRoot);

  const [activityOpen, setActivityOpen] = useState(false);

  useEffect(() => {
    if (selectedNodeId && (task?.status === 'completed' || task?.status === 'failed')) {
      if (!usage) fetchUsage(selectedNodeId);
      if (!plan) fetchPlan(selectedNodeId);
      if (!verification) fetchVerification(selectedNodeId);
      fetchEvents(selectedNodeId);
    }
  }, [selectedNodeId, task?.status, usage, plan, verification, fetchUsage, fetchPlan, fetchVerification, fetchEvents]);

  async function handleCancel() {
    if (!selectedNodeId) return;
    try {
      await cancelTaskApi(selectedNodeId);
      updateTaskStatus(selectedNodeId, 'cancelled');
    } catch {
      // Best-effort
    }
    setShowCancelConfirm(false);
  }

  async function handleRetry() {
    if (!selectedNodeId || !task) return;
    try {
      const resp = await fetch(`/api/tasks/${selectedNodeId}/retry`, { method: 'POST' });
      if (!resp.ok) return;
      const { id: newId } = await resp.json();
      // Add the new task to the sidebar and select it
      addRootTask({ id: newId, prompt: task.prompt, workDir: task.workDir ?? '', status: 'running', runId: null });
      selectRoot(newId);
    } catch {
      // Silently ignore retry errors
    }
  }

  function handleClose() {
    selectNode(null);
  }

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
              <p className="text-white text-sm mt-1 whitespace-pre-wrap">{task.prompt}</p>
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
          <button
            onClick={handleClose}
            className="text-gray-400 hover:text-white transition-colors cursor-pointer text-lg leading-none"
            title="Close detail panel"
          >
            x
          </button>
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
                status={taskStatus === 'completed' ? 'completed' : taskStatus === 'failed' ? 'failed' : taskStatus === 'awaiting_approval' ? 'awaiting_approval' : stageInfo.status}
              />
            </div>
          )}
          {/* Cancel button — visible when running, pending, or awaiting_approval */}
          {(taskStatus === 'running' || taskStatus === 'pending' || taskStatus === 'awaiting_approval') && (
            showCancelConfirm ? (
              <div className="flex items-center gap-2 ml-auto">
                <span className="text-sm text-gray-300">Cancel this task?</span>
                <button
                  onClick={handleCancel}
                  className="px-2 py-1 text-xs font-medium bg-red-600 hover:bg-red-700 text-white rounded transition-colors"
                >
                  Confirm
                </button>
                <button
                  onClick={() => setShowCancelConfirm(false)}
                  className="px-2 py-1 text-xs font-medium bg-gray-600 hover:bg-gray-500 text-white rounded transition-colors"
                >
                  No
                </button>
              </div>
            ) : (
              <button
                onClick={() => setShowCancelConfirm(true)}
                className="px-3 py-1 text-xs font-medium bg-red-600 hover:bg-red-700 text-white rounded transition-colors"
              >
                Cancel
              </button>
            )
          )}

          {/* Retry button — visible when failed or cancelled */}
          {(taskStatus === 'failed' || taskStatus === 'cancelled') && (
            <button
              onClick={handleRetry}
              className="px-3 py-1 text-xs font-medium bg-blue-600 hover:bg-blue-700 text-white rounded transition-colors"
            >
              Retry
            </button>
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
