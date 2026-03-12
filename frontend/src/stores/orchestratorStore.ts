import { create } from 'zustand';
import type {
  TaskSummary,
  TaskDetail,
  Plan,
  VerificationResult,
  WsMessage,
  TimelineEvent,
  UsageData,
  TaskStatus,
} from '../types.ts';
import { handlers, pushEvent } from './wsMessageHandlers.ts';

// --- Subtask execution status ---
type SubtaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

// --- Stage info per task ---
interface StageInfo {
  currentStage: string;
  status: string;
}

// --- Kanban column definitions ---
export const KANBAN_COLUMNS: { key: string; label: string; statuses: TaskStatus[] }[] = [
  { key: 'todo', label: 'TODO', statuses: ['todo'] },
  { key: 'queued', label: 'Queued', statuses: ['queued'] },
  { key: 'review', label: 'Need Review', statuses: ['awaiting_approval'] },
  { key: 'running', label: 'Running', statuses: ['running', 'pending'] },
  { key: 'failed', label: 'Failed', statuses: ['failed', 'cancelled'] },
  { key: 'done', label: 'Done', statuses: ['completed'] },
];

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
  usage: Map<string, UsageData>;

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
  fetchUsage: (taskId: string) => Promise<void>;
  fetchPlan: (taskId: string) => Promise<void>;
  fetchVerification: (taskId: string) => Promise<void>;
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
  usage: new Map(),

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
      // Guard: skip adding if task already exists in rootTasks
      if (state.rootTasks.some(t => t.id === task.id)) {
        return { nodeMap };
      }
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
    const handler = handlers[msg.type];
    if (handler) {
      (handler as (get: typeof get, set: typeof set, msg: WsMessage) => void)(get, set, msg);
    } else if ('taskId' in msg) {
      pushEvent(
        set as Parameters<typeof pushEvent>[0],
        (msg as { taskId: string }).taskId,
        (msg as { type: string }).type,
        (msg as { type: string }).type,
      );
    }
  },

  fetchUsage: async (taskId: string) => {
    try {
      const resp = await fetch(`/api/tasks/${taskId}/usage`);
      if (!resp.ok) return;
      const data = await resp.json();
      if (data.usage) {
        set((state) => {
          const usage = new Map(state.usage);
          usage.set(taskId, data.usage as UsageData);
          return { usage };
        });
      }
    } catch {
      // Silently ignore fetch errors for usage
    }
  },

  fetchPlan: async (taskId: string) => {
    try {
      const resp = await fetch(`/api/tasks/${taskId}/plan`);
      if (!resp.ok) return;
      const data = await resp.json();
      if (data.plan) {
        set((state) => {
          const plans = new Map(state.plans);
          plans.set(taskId, data.plan as Plan);
          return { plans };
        });
      }
    } catch {
      // Silently ignore fetch errors for plan
    }
  },

  fetchVerification: async (taskId: string) => {
    try {
      const resp = await fetch(`/api/tasks/${taskId}/verification`);
      if (!resp.ok) return;
      const data = await resp.json();
      if (data.verification) {
        set((state) => {
          const verifications = new Map(state.verifications);
          verifications.set(taskId, data.verification as VerificationResult);
          return { verifications };
        });
      }
    } catch {
      // Silently ignore fetch errors for verification
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

export const selectUsage = (state: OrchestratorState) => state.usage;
export const selectUsageForTask = (taskId: string) =>
  (state: OrchestratorState): UsageData | undefined =>
    state.usage.get(taskId);

export const selectEvents = (state: OrchestratorState) => state.events;
export const selectEventsForSelectedTask = (state: OrchestratorState): TimelineEvent[] => {
  const { selectedNodeId, events } = state;
  return selectedNodeId ? events.get(selectedNodeId) ?? [] : [];
};

/** Select tasks for a specific project, grouped by kanban column status. */
export const selectTasksByProjectGrouped = (projectId: string | null) =>
  (state: OrchestratorState) => {
    if (!projectId) return {};
    const tasks = state.rootTasks.filter(t => t.projectId === projectId);
    const groups: Record<string, TaskSummary[]> = {};
    for (const col of KANBAN_COLUMNS) {
      groups[col.key] = tasks.filter(t => col.statuses.includes(t.status));
    }
    return groups;
  };

/** Select tasks for a specific project. */
export const selectTasksByProject = (projectId: string | null) =>
  (state: OrchestratorState): TaskSummary[] => {
    if (!projectId) return [];
    return state.rootTasks.filter(t => t.projectId === projectId);
  };
