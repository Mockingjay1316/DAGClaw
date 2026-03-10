// --- Task types ---

export type TaskStatus =
  | 'pending'
  | 'running'
  | 'awaiting_approval'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'skipped';

export interface TaskSummary {
  id: string;
  prompt: string;
  workDir: string;
  status: TaskStatus;
  runId: string | null;
  error?: string;
}

export interface TaskDetail extends TaskSummary {
  error?: string;
  hasPendingApproval: boolean;
  pendingApprovalMessage?: string;
}

// --- Stage ---

export interface StageState {
  status: 'pending' | 'running' | 'completed' | 'failed';
  retryCount: number;
  output: unknown;
  error: string | null;
}

// --- Plan ---

export interface QualityFlag {
  concern: 'vague' | 'too_simple' | 'ambiguous' | 'missing_context';
  message: string;
  suggestion?: string;
}

export interface Subtask {
  index: number;
  description: string;
  prompt: string;
  dependencies: number[];
  estimatedComplexity: 'low' | 'medium' | 'high';
  needsRecursiveDecomposition: boolean;
  stage?: string;
}

export interface Plan {
  summary: string;
  subtasks: Subtask[];
  qualityFlag?: QualityFlag | null;
  worthDistilling: boolean;
}

// --- Verification ---

export interface SubtaskResult {
  subtaskIndex: number;
  pass: boolean;
  summary: string;
  retryRecommended: boolean;
}

export interface IntegrationResult {
  pass: boolean;
  summary: string;
  issues: string[];
}

export interface VerificationResult {
  overallPass: boolean;
  subtaskResults: SubtaskResult[];
  skippedIndices: number[];
  integrationResult: IntegrationResult;
}

// --- Timeline ---

export interface TimelineEvent {
  timestamp: number;
  type: string;
  taskId: string;
  message: string;
  data?: unknown;
}

// --- Usage ---

export interface StageUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  estimatedCost: number;
}

export interface UsageData {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  estimatedCost: number;
  perStage: Record<string, StageUsage>;
  perSubtask: Record<string, StageUsage>;
}

// --- Server → Client WebSocket Messages ---

export type WsMessage =
  | { type: 'tree_snapshot'; taskId: string; subtasks: { index: number; description: string; dependencies: number[]; stage: string }[] }
  | { type: 'node_created'; taskId: string; nodeId: string }
  | { type: 'node_status'; taskId: string; message: string }
  | { type: 'stage_start'; taskId: string; label: string; stageName: string }
  | { type: 'stage_complete'; taskId: string }
  | { type: 'subtask_start'; taskId: string; index: number }
  | { type: 'subtask_output'; taskId: string; index: number; data: string }
  | { type: 'subtask_complete'; taskId: string; index: number; oneliner?: string; error?: string; elapsed?: number }
  | { type: 'approval_required'; taskId: string; message: string }
  | { type: 'approval_resolved'; taskId: string; approved: boolean }
  | { type: 'plan_ready'; taskId: string; plan: Plan }
  | { type: 'task_error'; taskId: string; error: string }
  | { type: 'task_complete'; taskId: string }
  | { type: 'verification_result'; taskId: string; result: VerificationResult }
  | { type: 'retry'; taskId: string; indices: number[] }
  | { type: 'usage_update'; taskId: string; usage: { totalInputTokens: number; totalOutputTokens: number; totalCacheReadTokens: number; estimatedCost: number; perStage: Record<string, { inputTokens: number; outputTokens: number; cacheReadTokens: number; estimatedCost: number }>; perSubtask: Record<string, { inputTokens: number; outputTokens: number; cacheReadTokens: number; estimatedCost: number }> } };

// --- Client → Server WebSocket Messages ---

export type WsClientMessage =
  | { type: 'subscribe'; nodeIds: string[] }
  | { type: 'unsubscribe'; nodeIds: string[] }
  | { type: 'approve_plan'; taskId: string }
  | { type: 'reject_plan'; taskId: string; feedback?: string }
  | { type: 'cancel'; taskId: string };
