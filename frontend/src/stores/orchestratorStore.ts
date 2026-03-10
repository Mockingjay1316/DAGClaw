import { create } from 'zustand';
import type {
  TaskSummary,
  TaskDetail,
  Plan,
  VerificationResult,
  WsMessage,
  TimelineEvent,
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
  events: Map<string, TimelineEvent[]>;

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
  events: new Map(),

  // Actions
  setRootTasks: (tasks) =>
    set((state) => {
      const nodeMap = new Map(state.nodeMap);
      for (const task of tasks) {
        if (!nodeMap.has(task.id)) {
          nodeMap.set(task.id, { ...task, hasPendingApproval: false });
        }
      }
      return { rootTasks: tasks, nodeMap };
    }),

  addRootTask: (task) =>
    set((state) => {
      const nodeMap = new Map(state.nodeMap);
      nodeMap.set(task.id, { ...task, hasPendingApproval: false });
      return { rootTasks: [...state.rootTasks, task], nodeMap };
    }),

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

    const pushEvent = (taskId: string, type: string, message: string, data?: unknown) => {
      set((state) => {
        const events = new Map(state.events);
        const taskEvents = [...(events.get(taskId) ?? [])];
        const event: TimelineEvent = { timestamp: Date.now(), type, taskId, message, data };
        taskEvents.push(event);
        if (taskEvents.length > 500) {
          taskEvents.splice(0, taskEvents.length - 500);
        }
        events.set(taskId, taskEvents);
        return { events };
      });
    };

    switch (msg.type) {
      case 'node_status':
        // Status log messages — don't change task status, just log for debugging
        console.log(`[${msg.taskId}] ${msg.message}`);
        pushEvent(msg.taskId, msg.type, `${msg.message}`);
        break;

      case 'stage_start':
        set((state) => {
          const stageInfo = new Map(state.stageInfo);
          stageInfo.set(msg.taskId, { currentStage: msg.stageName, status: 'running' });
          return { stageInfo };
        });
        pushEvent(msg.taskId, msg.type, `Stage ${msg.stageName} started`);
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
        pushEvent(msg.taskId, msg.type, `Stage completed`);
        break;

      case 'subtask_start':
        store.setSubtaskStatus(msg.taskId, msg.index, 'running');
        pushEvent(msg.taskId, msg.type, `Subtask ${msg.index} started`);
        break;

      case 'subtask_complete': {
        const status: SubtaskStatus = msg.error ? 'failed' : 'completed';
        store.setSubtaskStatus(msg.taskId, msg.index, status);
        const elapsed = msg.elapsed ? ` in ${msg.elapsed}ms` : '';
        pushEvent(msg.taskId, msg.type, `Subtask ${msg.index} ${msg.error ? 'failed' : 'completed'}${elapsed}`);
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
        pushEvent(msg.taskId, msg.type, `Plan approval required`);
        break;

      case 'approval_resolved':
        store.updateTaskStatus(msg.taskId, msg.approved ? 'running' : 'failed');
        set((state) => {
          const nodeMap = new Map(state.nodeMap);
          const existing = nodeMap.get(msg.taskId);
          if (existing) {
            nodeMap.set(msg.taskId, {
              ...existing,
              status: msg.approved ? 'running' : 'failed',
              hasPendingApproval: false,
              pendingApprovalMessage: undefined,
            });
          }
          return { nodeMap };
        });
        pushEvent(msg.taskId, msg.type, `Plan ${msg.approved ? 'approved' : 'rejected'}`);
        break;

      case 'plan_ready':
        store.setPlan(msg.taskId, msg.plan);
        pushEvent(msg.taskId, msg.type, `Plan ready (${msg.plan.subtasks.length} subtasks)`);
        break;

      case 'task_error':
        store.updateTaskStatus(msg.taskId, 'failed');
        set((state) => {
          const nodeMap = new Map(state.nodeMap);
          const existing = nodeMap.get(msg.taskId);
          if (existing) {
            nodeMap.set(msg.taskId, { ...existing, status: 'failed', error: msg.error });
          }
          return { nodeMap };
        });
        pushEvent(msg.taskId, msg.type, `Task error: ${msg.error}`);
        break;

      case 'task_complete':
        store.updateTaskStatus(msg.taskId, 'completed');
        pushEvent(msg.taskId, msg.type, `Task completed`);
        break;

      case 'verification_result':
        store.setVerification(msg.taskId, msg.result);
        pushEvent(msg.taskId, msg.type, `Verification ${msg.result.overallPass ? 'passed' : 'failed'}`);
        break;

      case 'tree_snapshot':
        pushEvent(msg.taskId, msg.type, `DAG snapshot: ${msg.subtasks.length} subtasks`);
        break;

      case 'retry':
        pushEvent(msg.taskId, msg.type, `Retrying subtasks: ${msg.indices.join(', ')}`);
        break;

      default:
        pushEvent(msg.taskId, msg.type, msg.type);
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

export const selectEvents = (state: OrchestratorState) => state.events;
export const selectEventsForSelectedTask = (state: OrchestratorState): TimelineEvent[] => {
  const { selectedNodeId, events } = state;
  return selectedNodeId ? events.get(selectedNodeId) ?? [] : [];
};
