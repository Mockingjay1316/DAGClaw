import { create } from 'zustand';
import type {
  TaskSummary,
  TaskDetail,
  Plan,
  VerificationResult,
  WsMessage,
} from '../types.ts';

// --- Subtask execution status ---
type SubtaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

// --- Stage info per task ---
interface StageInfo {
  currentStage: string;
  status: string;
}

// --- Store state ---
interface OrchestratorState {
  rootTasks: TaskSummary[];
  nodeMap: Map<string, TaskDetail>;
  selectedRootId: string | null;
  selectedNodeId: string | null;
  expandedNodes: Set<string>;
  plans: Map<string, Plan>;
  verifications: Map<string, VerificationResult>;
  subtaskStatuses: Map<string, Map<number, SubtaskStatus>>;
  stageInfo: Map<string, StageInfo>;

  // Actions
  setRootTasks: (tasks: TaskSummary[]) => void;
  addRootTask: (task: TaskSummary) => void;
  updateTaskStatus: (taskId: string, status: string) => void;
  selectRoot: (id: string | null) => void;
  selectNode: (id: string | null) => void;
  toggleExpand: (id: string) => void;
  setPlan: (taskId: string, plan: Plan) => void;
  setVerification: (taskId: string, result: VerificationResult) => void;
  setSubtaskStatus: (taskId: string, index: number, status: SubtaskStatus) => void;
  handleWsMessage: (msg: WsMessage) => void;
}

export const useOrchestratorStore = create<OrchestratorState>((set, get) => ({
  // State
  rootTasks: [],
  nodeMap: new Map(),
  selectedRootId: null,
  selectedNodeId: null,
  expandedNodes: new Set(),
  plans: new Map(),
  verifications: new Map(),
  subtaskStatuses: new Map(),
  stageInfo: new Map(),

  // Actions
  setRootTasks: (tasks) =>
    set({ rootTasks: tasks }),

  addRootTask: (task) =>
    set((state) => ({ rootTasks: [...state.rootTasks, task] })),

  updateTaskStatus: (taskId, status) =>
    set((state) => {
      // Update in rootTasks
      const rootTasks = state.rootTasks.map((t) =>
        t.id === taskId ? { ...t, status: status as TaskSummary['status'] } : t
      );

      // Update in nodeMap
      const nodeMap = new Map(state.nodeMap);
      const existing = nodeMap.get(taskId);
      if (existing) {
        nodeMap.set(taskId, { ...existing, status: status as TaskDetail['status'] });
      }

      return { rootTasks, nodeMap };
    }),

  selectRoot: (id) =>
    set({ selectedRootId: id, selectedNodeId: id }),

  selectNode: (id) =>
    set({ selectedNodeId: id }),

  toggleExpand: (id) =>
    set((state) => {
      const expandedNodes = new Set(state.expandedNodes);
      if (expandedNodes.has(id)) {
        expandedNodes.delete(id);
      } else {
        expandedNodes.add(id);
      }
      return { expandedNodes };
    }),

  setPlan: (taskId, plan) =>
    set((state) => {
      const plans = new Map(state.plans);
      plans.set(taskId, plan);
      return { plans };
    }),

  setVerification: (taskId, result) =>
    set((state) => {
      const verifications = new Map(state.verifications);
      verifications.set(taskId, result);
      return { verifications };
    }),

  setSubtaskStatus: (taskId, index, status) =>
    set((state) => {
      const subtaskStatuses = new Map(state.subtaskStatuses);
      const taskMap = new Map(subtaskStatuses.get(taskId) ?? new Map());
      taskMap.set(index, status);
      subtaskStatuses.set(taskId, taskMap);
      return { subtaskStatuses };
    }),

  handleWsMessage: (msg) => {
    const store = get();

    switch (msg.type) {
      case 'node_status':
        store.updateTaskStatus(msg.taskId, msg.message);
        break;

      case 'stage_start':
        set((state) => {
          const stageInfo = new Map(state.stageInfo);
          stageInfo.set(msg.taskId, { currentStage: msg.label, status: 'running' });
          return { stageInfo };
        });
        break;

      case 'stage_complete':
        set((state) => {
          const stageInfo = new Map(state.stageInfo);
          const existing = stageInfo.get(msg.taskId);
          if (existing) {
            stageInfo.set(msg.taskId, { ...existing, status: 'completed' });
          }
          return { stageInfo };
        });
        break;

      case 'subtask_start':
        store.setSubtaskStatus(msg.taskId, msg.index, 'running');
        break;

      case 'subtask_complete': {
        const status: SubtaskStatus = msg.error ? 'failed' : 'completed';
        store.setSubtaskStatus(msg.taskId, msg.index, status);
        break;
      }

      case 'approval_required':
        store.updateTaskStatus(msg.taskId, 'awaiting_approval');
        // If there's plan data associated, it should be set via a separate setPlan call.
        // Update the node with the pending approval message.
        set((state) => {
          const nodeMap = new Map(state.nodeMap);
          const existing = nodeMap.get(msg.taskId);
          if (existing) {
            nodeMap.set(msg.taskId, {
              ...existing,
              hasPendingApproval: true,
              pendingApprovalMessage: msg.message,
            });
          }
          return { nodeMap };
        });
        break;

      case 'verification_result':
        store.setVerification(msg.taskId, msg.result);
        break;

      // Other message types (tree_snapshot, node_created, subtask_output, retry) can be
      // handled by consumers or extended here as needed.
      default:
        break;
    }
  },
}));

// --- Selectors for performance ---

export const selectRootTasks = (state: OrchestratorState) => state.rootTasks;
export const selectSelectedRootId = (state: OrchestratorState) => state.selectedRootId;
export const selectSelectedNodeId = (state: OrchestratorState) => state.selectedNodeId;
export const selectExpandedNodes = (state: OrchestratorState) => state.expandedNodes;
export const selectNodeMap = (state: OrchestratorState) => state.nodeMap;
export const selectPlans = (state: OrchestratorState) => state.plans;
export const selectVerifications = (state: OrchestratorState) => state.verifications;
export const selectSubtaskStatuses = (state: OrchestratorState) => state.subtaskStatuses;
export const selectStageInfo = (state: OrchestratorState) => state.stageInfo;

// Derived selectors
export const selectSelectedTask = (state: OrchestratorState): TaskDetail | undefined => {
  const { selectedNodeId, nodeMap } = state;
  return selectedNodeId ? nodeMap.get(selectedNodeId) : undefined;
};

export const selectPlanForSelectedTask = (state: OrchestratorState): Plan | undefined => {
  const { selectedNodeId, plans } = state;
  return selectedNodeId ? plans.get(selectedNodeId) : undefined;
};

export const selectVerificationForSelectedTask = (state: OrchestratorState): VerificationResult | undefined => {
  const { selectedNodeId, verifications } = state;
  return selectedNodeId ? verifications.get(selectedNodeId) : undefined;
};

export const selectStageInfoForTask = (taskId: string) =>
  (state: OrchestratorState): StageInfo | undefined =>
    state.stageInfo.get(taskId);

export const selectSubtaskStatusesForTask = (taskId: string) =>
  (state: OrchestratorState): Map<number, SubtaskStatus> | undefined =>
    state.subtaskStatuses.get(taskId);
