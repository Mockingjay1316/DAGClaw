import { useOrchestratorStore } from '../stores/orchestratorStore.ts';
import { PlanView } from './PlanView.tsx';
import { ApprovalBanner } from './ApprovalBanner.tsx';
import { ExecutionView } from './ExecutionView.tsx';
import { VerifyView } from './VerifyView.tsx';

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

  if (!selectedNodeId) {
    return (
      <div className="flex-1 bg-gray-900 overflow-y-auto p-4 flex items-center justify-center text-gray-500">
        Select a task to view details
      </div>
    );
  }

  const hasPendingApproval = task?.hasPendingApproval ?? false;
  const currentStage = stageInfo?.currentStage ?? '';

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
        <h2 className="text-lg font-semibold text-white">Task Summary</h2>
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
            <div>
              <span className="text-gray-400 text-sm">Status:</span>
              <span className="ml-2 text-sm text-white capitalize">{task.status}</span>
            </div>
            {task.error && (
              <div>
                <span className="text-gray-400 text-sm">Error:</span>
                <p className="text-red-400 text-sm mt-1">{task.error}</p>
              </div>
            )}
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
    <div className="flex-1 bg-gray-900 overflow-y-auto p-4">
      {renderContent()}
      {hasPendingApproval && task?.pendingApprovalMessage && (
        <ApprovalBanner
          taskId={selectedNodeId}
          message={task.pendingApprovalMessage}
        />
      )}
    </div>
  );
}
