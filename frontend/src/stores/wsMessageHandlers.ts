import type {
  TaskSummary,
  Plan,
  VerificationResult,
  WsMessage,
  TimelineEvent,
  UsageData,
} from '../types.ts';
import { subscribe, unsubscribe } from '../hooks/useWebSocket.ts';

type SubtaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

// Minimal interface for the store operations needed by handlers
interface StoreApi {
  updateTaskStatus: (taskId: string, status: string) => void;
  setPlan: (taskId: string, plan: Plan) => void;
  setVerification: (taskId: string, result: VerificationResult) => void;
  setSubtaskStatus: (taskId: string, index: number, status: SubtaskStatus) => void;
  addRootTask: (task: TaskSummary) => void;
  setColumnCounts: (counts: Record<string, number>) => void;
  fetchUsage: (taskId: string) => Promise<void>;
}

type GetState = () => StoreApi & {
  rootTasks: TaskSummary[];
  nodeMap: Map<string, unknown>;
  stageInfo: Map<string, { currentStage: string; status: string }>;
  events: Map<string, TimelineEvent[]>;
  usage: Map<string, UsageData>;
  columnCounts: Record<string, number>;
};

type SetState = (
  updater: (state: {
    rootTasks: TaskSummary[];
    nodeMap: Map<string, Record<string, unknown>>;
    stageInfo: Map<string, { currentStage: string; status: string }>;
    events: Map<string, TimelineEvent[]>;
    usage: Map<string, UsageData>;
    columnCounts: Record<string, number>;
  }) => Record<string, unknown>
) => void;

function pushEvent(
  set: SetState,
  taskId: string,
  type: string,
  message: string,
  _data?: unknown,
): void {
  set((state) => {
    const events = new Map(state.events);
    const taskEvents = [...(events.get(taskId) ?? [])];
    // Dedup: skip if any of the last 5 events has the same type AND message
    const recentEvents = taskEvents.slice(-5);
    if (recentEvents.some(e => e.type === type && e.message === message)) {
      return { events };
    }
    const event: TimelineEvent = { timestamp: Date.now(), type, taskId, message, data: _data };
    taskEvents.push(event);
    if (taskEvents.length > 500) {
      taskEvents.splice(0, taskEvents.length - 500);
    }
    events.set(taskId, taskEvents);
    return { events };
  });
}

function handleNodeStatus(get: GetState, set: SetState, msg: Extract<WsMessage, { type: 'node_status' }>) {
  console.log(`[${msg.taskId}] ${msg.message}`);
  pushEvent(set, msg.taskId, msg.type, `${msg.message}`);
}

function handleStageStart(get: GetState, set: SetState, msg: Extract<WsMessage, { type: 'stage_start' }>) {
  set((state) => {
    const stageInfo = new Map(state.stageInfo);
    stageInfo.set(msg.taskId, { currentStage: msg.stageName, status: 'running' });
    return { stageInfo };
  });
  pushEvent(set, msg.taskId, msg.type, `Stage ${msg.stageName} started`);
}

function handleStageComplete(get: GetState, set: SetState, msg: Extract<WsMessage, { type: 'stage_complete' }>) {
  set((state) => {
    const stageInfo = new Map(state.stageInfo);
    const existing = stageInfo.get(msg.taskId);
    if (existing) {
      stageInfo.set(msg.taskId, { ...existing, status: 'completed' });
    }
    return { stageInfo };
  });
  pushEvent(set, msg.taskId, msg.type, `Stage completed`);
}

function handleSubtaskStart(get: GetState, set: SetState, msg: Extract<WsMessage, { type: 'subtask_start' }>) {
  get().setSubtaskStatus(msg.taskId, msg.index, 'running');
  pushEvent(set, msg.taskId, msg.type, `Subtask ${msg.index} started`);
}

function handleSubtaskComplete(get: GetState, set: SetState, msg: Extract<WsMessage, { type: 'subtask_complete' }>) {
  const status: SubtaskStatus = msg.error ? 'failed' : 'completed';
  get().setSubtaskStatus(msg.taskId, msg.index, status);
  const elapsed = msg.elapsed ? ` in ${(msg.elapsed / 1000).toFixed(1)}s` : '';
  pushEvent(set, msg.taskId, msg.type, `Subtask ${msg.index} ${msg.error ? 'failed' : 'completed'}${elapsed}`);
}

function handleApprovalRequired(get: GetState, set: SetState, msg: Extract<WsMessage, { type: 'approval_required' }>) {
  get().updateTaskStatus(msg.taskId, 'awaiting_approval');
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
    // Fix: update stageInfo to reflect awaiting_approval, not completed
    const stageInfo = new Map(state.stageInfo);
    const existingSi = stageInfo.get(msg.taskId);
    if (existingSi) {
      stageInfo.set(msg.taskId, { ...existingSi, status: 'awaiting_approval' });
    }

    return { nodeMap, stageInfo };
  });
  pushEvent(set, msg.taskId, msg.type, `Plan approval required`);
}

function handleApprovalResolved(get: GetState, set: SetState, msg: Extract<WsMessage, { type: 'approval_resolved' }>) {
  get().updateTaskStatus(msg.taskId, msg.approved ? 'running' : 'cancelled');
  set((state) => {
    const nodeMap = new Map(state.nodeMap);
    const existing = nodeMap.get(msg.taskId);
    if (existing) {
      nodeMap.set(msg.taskId, {
        ...existing,
        status: msg.approved ? 'running' : 'cancelled',
        hasPendingApproval: false,
        pendingApprovalMessage: undefined,
      });
    }
    return { nodeMap };
  });
  if (!msg.approved) {
    set((state) => {
      const stageInfo = new Map(state.stageInfo);
      stageInfo.set(msg.taskId, { currentStage: 'Cancelled', status: 'cancelled' });
      return { stageInfo };
    });
  }
  pushEvent(set, msg.taskId, msg.type, `Plan ${msg.approved ? 'approved' : 'rejected'}`);
}

function handlePlanReady(get: GetState, set: SetState, msg: Extract<WsMessage, { type: 'plan_ready' }>) {
  get().setPlan(msg.taskId, msg.plan);
  pushEvent(set, msg.taskId, msg.type, `Plan ready (${msg.plan.subtasks.length} subtasks)`);
}

function handleTaskError(get: GetState, set: SetState, msg: Extract<WsMessage, { type: 'task_error' }>) {
  get().updateTaskStatus(msg.taskId, 'failed');
  set((state) => {
    const nodeMap = new Map(state.nodeMap);
    const existing = nodeMap.get(msg.taskId);
    if (existing) {
      nodeMap.set(msg.taskId, { ...existing, status: 'failed', error: msg.error });
    }
    const stageInfo = new Map(state.stageInfo);
    const existingSi = stageInfo.get(msg.taskId);
    stageInfo.set(msg.taskId, { currentStage: existingSi?.currentStage ?? 'Failed', status: 'failed' });
    const rootTasks = state.rootTasks.map(t =>
      t.id === msg.taskId ? { ...t, finishedAt: t.finishedAt || new Date().toISOString() } : t
    );
    return { nodeMap, stageInfo, rootTasks };
  });
  unsubscribe([msg.taskId]);
  pushEvent(set, msg.taskId, msg.type, `Task error: ${msg.error}`);
}

function handleTaskComplete(get: GetState, set: SetState, msg: Extract<WsMessage, { type: 'task_complete' }>) {
  get().updateTaskStatus(msg.taskId, 'completed');
  set((state) => {
    const stageInfo = new Map(state.stageInfo);
    stageInfo.set(msg.taskId, { currentStage: 'Done', status: 'completed' });
    const rootTasks = state.rootTasks.map(t =>
      t.id === msg.taskId ? { ...t, finishedAt: t.finishedAt || new Date().toISOString() } : t
    );
    return { stageInfo, rootTasks };
  });
  unsubscribe([msg.taskId]);
  pushEvent(set, msg.taskId, msg.type, `Task completed`);
}

function handleVerificationResult(get: GetState, set: SetState, msg: Extract<WsMessage, { type: 'verification_result' }>) {
  get().setVerification(msg.taskId, msg.result);
  pushEvent(set, msg.taskId, msg.type, `Verification ${msg.result.overallPass ? 'passed' : 'failed'}`);
}

function handleTreeSnapshot(get: GetState, set: SetState, msg: Extract<WsMessage, { type: 'tree_snapshot' }>) {
  pushEvent(set, msg.taskId, msg.type, `DAG snapshot: ${msg.subtasks.length} subtasks`);
}

function handleRetry(get: GetState, set: SetState, msg: Extract<WsMessage, { type: 'retry' }>) {
  pushEvent(set, msg.taskId, msg.type, `Retrying subtasks: ${msg.indices.join(', ')}`);
}

function handleUsageUpdate(get: GetState, set: SetState, msg: Extract<WsMessage, { type: 'usage_update' }>) {
  set((state) => {
    const usage = new Map(state.usage);
    usage.set(msg.taskId, msg.usage as UsageData);
    return { usage };
  });
}

function handleTaskStatusChanged(get: GetState, set: SetState, msg: Extract<WsMessage, { type: 'task_status_changed' }>) {
  get().updateTaskStatus(msg.taskId, msg.newStatus);
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
    const columnCounts = { ...state.columnCounts };
    if (columnCounts[msg.oldStatus] > 0) columnCounts[msg.oldStatus]--;
    columnCounts[msg.newStatus] = (columnCounts[msg.newStatus] || 0) + 1;
    return { rootTasks, columnCounts };
  });

  // Auto-subscribe when task starts running
  if (msg.newStatus === 'running') {
    subscribe([msg.taskId]);
  }
  // Auto-unsubscribe when task reaches terminal state
  if (['completed', 'failed', 'cancelled'].includes(msg.newStatus)) {
    unsubscribe([msg.taskId]);
  }
}

function handleProjectTasksSnapshot(get: GetState, set: SetState, msg: Extract<WsMessage, { type: 'project_tasks_snapshot' }>) {
  if (msg.counts) {
    get().setColumnCounts(msg.counts);
  }
  set((state) => {
    const nodeMap = new Map(state.nodeMap);
    for (const task of msg.tasks) {
      if (!nodeMap.has(task.id)) {
        nodeMap.set(task.id, { ...task, hasPendingApproval: false });
      }
    }
    const existingIds = new Set(state.rootTasks.map(t => t.id));
    const newTasks = msg.tasks.filter(t => !existingIds.has(t.id));
    return {
      rootTasks: [...state.rootTasks, ...newTasks],
      nodeMap,
    };
  });
  // Eagerly fetch usage for completed/failed tasks
  for (const task of msg.tasks) {
    if ((task.status === 'completed' || task.status === 'failed') && task.runId && !get().usage.has(task.id)) {
      get().fetchUsage(task.id);
    }
  }
}

function handleTaskCreated(get: GetState, set: SetState, msg: Extract<WsMessage, { type: 'task_created' }>) {
  get().addRootTask(msg.task);
  set((state) => {
    const columnCounts = { ...state.columnCounts };
    columnCounts[msg.task.status] = (columnCounts[msg.task.status] || 0) + 1;
    return { columnCounts };
  });
  if ((msg.task.status === 'completed' || msg.task.status === 'failed') && msg.task.runId && !get().usage.has(msg.task.id)) {
    get().fetchUsage(msg.task.id);
  }
}

type MessageHandler = (get: GetState, set: SetState, msg: never) => void;

export const handlers: Record<string, MessageHandler> = {
  node_status: handleNodeStatus as MessageHandler,
  stage_start: handleStageStart as MessageHandler,
  stage_complete: handleStageComplete as MessageHandler,
  subtask_start: handleSubtaskStart as MessageHandler,
  subtask_complete: handleSubtaskComplete as MessageHandler,
  approval_required: handleApprovalRequired as MessageHandler,
  approval_resolved: handleApprovalResolved as MessageHandler,
  plan_ready: handlePlanReady as MessageHandler,
  task_error: handleTaskError as MessageHandler,
  task_complete: handleTaskComplete as MessageHandler,
  verification_result: handleVerificationResult as MessageHandler,
  tree_snapshot: handleTreeSnapshot as MessageHandler,
  retry: handleRetry as MessageHandler,
  usage_update: handleUsageUpdate as MessageHandler,
  task_status_changed: handleTaskStatusChanged as MessageHandler,
  project_tasks_snapshot: handleProjectTasksSnapshot as MessageHandler,
  task_created: handleTaskCreated as MessageHandler,
};

export { pushEvent };
