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
    const store = get();

    const pushEvent = (taskId: string, type: string, message: string, data?: unknown) => {
      set((state) => {
        const events = new Map(state.events);
        const taskEvents = [...(events.get(taskId) ?? [])];
        // Dedup: skip if any of the last 5 events has the same type AND message
        const recentEvents = taskEvents.slice(-5);
        if (recentEvents.some(e => e.type === type && e.message === message)) {
          return { events };
        }
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
          const stageInfo = new Map(state.stageInfo);
          const existingSi = stageInfo.get(msg.taskId);
          stageInfo.set(msg.taskId, { currentStage: existingSi?.currentStage ?? 'Failed', status: 'failed' });
          // Set finishedAt on the task
          const rootTasks = state.rootTasks.map(t =>
            t.id === msg.taskId ? { ...t, finishedAt: t.finishedAt || new Date().toISOString() } : t
          );
          return { nodeMap, stageInfo, rootTasks };
        });
        pushEvent(msg.taskId, msg.type, `Task error: ${msg.error}`);
        break;

      case 'task_complete':
        store.updateTaskStatus(msg.taskId, 'completed');
        set((state) => {
          const stageInfo = new Map(state.stageInfo);
          stageInfo.set(msg.taskId, { currentStage: 'Done', status: 'completed' });
          // Set finishedAt on the task
          const rootTasks = state.rootTasks.map(t =>
            t.id === msg.taskId ? { ...t, finishedAt: t.finishedAt || new Date().toISOString() } : t
          );
          return { stageInfo, rootTasks };
        });
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

      case 'usage_update':
        set((state) => {
          const usage = new Map(state.usage);
          usage.set(msg.taskId, msg.usage as UsageData);
          return { usage };
        });
        break;

      // New project-level messages
      case 'task_status_changed':
        store.updateTaskStatus(msg.taskId, msg.newStatus);
        set((state) => {
          const now = new Date().toISOString();
          const rootTasks = state.rootTasks.map(t => {
            if (t.id !== msg.taskId) return t;
            const updates: Partial<TaskSummary> = {};
            if (msg.newStatus === 'running' && !t.startedAt) {
              updates.startedAt = now;
            }
            if (['completed', 'failed', 'cancelled'].includes(msg.newStatus) && !t.finishedAt) {
              updates.finishedAt = now;
            }
            return Object.keys(updates).length > 0 ? { ...t, ...updates } : t;
          });
          return { rootTasks };
        });
        break;

      case 'project_tasks_snapshot':
        set((state) => {
          const nodeMap = new Map(state.nodeMap);
          for (const task of msg.tasks) {
            if (!nodeMap.has(task.id)) {
              nodeMap.set(task.id, { ...task, hasPendingApproval: false });
            }
          }
          // Merge with existing rootTasks (avoid duplicates)
          const existingIds = new Set(state.rootTasks.map(t => t.id));
          const newTasks = msg.tasks.filter(t => !existingIds.has(t.id));
          return {
            rootTasks: [...state.rootTasks, ...newTasks],
            nodeMap,
          };
        });
        // Eagerly fetch usage for completed tasks so cost data appears immediately
        for (const task of msg.tasks) {
          if (task.status === 'completed' && task.runId && !get().usage.has(task.id)) {
            get().fetchUsage(task.id);
          }
        }
        break;

      case 'task_created':
        store.addRootTask(msg.task);
        // If task arrives already completed (e.g., via retry), eagerly fetch usage
        if (msg.task.status === 'completed' && msg.task.runId && !get().usage.has(msg.task.id)) {
          get().fetchUsage(msg.task.id);
        }
        break;

      default:
        if ('taskId' in msg) {
          pushEvent((msg as { taskId: string }).taskId, (msg as { type: string }).type, (msg as { type: string }).type);
        }
        break;
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
