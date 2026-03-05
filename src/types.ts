import { z } from 'zod';

// --- Permission & Backend ---

export type PermissionMode = 'interactive' | 'auto' | 'plan-only';

export type RunnerBackend =
  | { type: 'sdk' }
  | { type: 'cli' };
// Future (v0.2+): | { type: 'custom'; command: string }

// --- Usage & Cost ---

export interface UsageStats {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  estimatedCost: number;
  durationMs: number;
}

// --- Context ---

export interface ContextSnapshot {
  nodeId: string;
  stage: string;
  subtaskIndex?: number;
  oneliner: string;
  filesModified: string[];
  summary: string;
  sessionId: string;
}

export interface ContextBudget {
  maxContextChars: number; // rough: chars / 4 ~ tokens
}

// --- Plan ---

export const QualityFlagSchema = z.object({
  concern: z.enum(['vague', 'too_simple', 'ambiguous', 'missing_context']),
  message: z.string(),
  suggestion: z.string().optional(),
});

export const SubtaskSchema = z.object({
  index: z.number(),
  description: z.string(),
  prompt: z.string(),
  dependencies: z.array(z.number()),
  estimatedComplexity: z.enum(['low', 'medium', 'high']),
  needsRecursiveDecomposition: z.boolean(),
});

export const PlanSchema = z.object({
  summary: z.string(),
  subtasks: z.array(SubtaskSchema),
  qualityFlag: QualityFlagSchema.optional(),
  worthDistilling: z.boolean(),
});

export type QualityFlag = z.infer<typeof QualityFlagSchema>;
export type Subtask = z.infer<typeof SubtaskSchema>;
export type Plan = z.infer<typeof PlanSchema>;

// --- Verification ---

export const SubtaskResultSchema = z.object({
  subtaskIndex: z.number(),
  pass: z.boolean(),
  summary: z.string(),
  retryRecommended: z.boolean(),
});

export const IntegrationResultSchema = z.object({
  pass: z.boolean(),
  summary: z.string(),
  issues: z.array(z.string()),
});

export const VerificationResultSchema = z.object({
  overallPass: z.boolean(),
  subtaskResults: z.array(SubtaskResultSchema),
  skippedIndices: z.array(z.number()),
  integrationResult: IntegrationResultSchema,
});

export type SubtaskResult = z.infer<typeof SubtaskResultSchema>;
export type IntegrationResult = z.infer<typeof IntegrationResultSchema>;
export type VerificationResult = z.infer<typeof VerificationResultSchema>;

// --- Executor Output ---

export const ExecutorOutputSchema = z.object({
  summary: z.string(),
  oneliner: z.string(),
});

export type ExecutorOutput = z.infer<typeof ExecutorOutputSchema>;

// --- Stage ---

export type TaskStatus =
  | 'pending'
  | 'running'
  | 'awaiting_approval'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'skipped';

export interface StageState {
  status: 'pending' | 'running' | 'completed' | 'failed';
  retryCount: number;
  output: unknown;
  error: string | null;
}

export interface ClaudeRunnerConfig {
  backend?: RunnerBackend;
  systemPrompt: string;
  promptTemplate: string;
  outputFile?: string; // path in .claw/tmp/ where agent writes structured output
  allowedTools?: string[];
  workDir?: string;
  permissionMode?: PermissionMode;
  contextSnapshots?: ContextSnapshot[];
  resumeSessionId?: string;
  timeoutMs?: number; // default 300000 (5 min)
}

export interface ClaudeRunnerResult {
  rawOutput: string;
  structuredOutput?: unknown;
  sessionId: string;
  contextSnapshot: ContextSnapshot;
  messages: unknown[];
  usage: UsageStats;
}

export interface SubtaskDefinition {
  index: number;
  prompt: string;
  dependencies: number[];
}

/**
 * Pipeline state passed between stages.
 * Each stage reads what it needs and writes its output here.
 */
export interface PipelineState {
  prompt: string;
  workDir: string;
  plan: Plan | null;
  subtaskSnapshots: Map<number, ContextSnapshot>;
  skippedIndices: number[];
  memoryContext: string;
  verification: VerificationResult | null;
}

export interface StageDefinition {
  name: string;
  runnerConfig: Partial<ClaudeRunnerConfig>;
  approvalRequired?: boolean;
  /** If true, uses DAG from plan subtasks for parallel execution. */
  parallel?: boolean;
  /** Extract subtask definitions from prior pipeline state (for parallel stages). */
  subtaskExtractor?: (state: PipelineState) => SubtaskDefinition[];
  /** Build the template context dict for this stage's prompt. */
  contextBuilder: (state: PipelineState, outputFile: string, subtask?: SubtaskDefinition) => Record<string, string>;
  /** Parse and apply the stage's output to pipeline state. Returns display message. */
  resultHandler: (state: PipelineState, outputFile: string, subtask?: SubtaskDefinition, sessionId?: string) => string;
  /** Interpret result for pass/fail (verify stage). */
  resultInterpreter?: (output: unknown) => {
    pass: boolean;
    failedIndices?: number[];
  };
  integrationVerifier?: boolean;
  maxRetries?: number;
  /** Format a status line for this stage/subtask. */
  formatStatus?: (subtask?: SubtaskDefinition, status?: string) => string;
}

// --- Task Node ---

export interface TaskNode {
  id: string;
  parentId: string | null;
  prompt: string;
  workDir: string;
  stagePipeline: string[];
  stageOverrides?: Record<string, Partial<StageDefinition>>;
  currentStageIndex: number;
  status: TaskStatus;
  stages: Record<string, StageState>;
  plan: Plan | null;
  children: string[];
  autoApprove: boolean;
  maxRetries: number;
  permissionMode: PermissionMode;
}

// --- Run Manifest ---

export interface TaskNodeSummary {
  id: string;
  prompt: string;
  status: TaskStatus;
  stages: Record<string, StageState>;
  children: TaskNodeSummary[];
}

export interface RunManifest {
  id: string;
  prompt: string;
  workDir: string;
  pipeline: string[];
  backend: string;
  permissionMode: PermissionMode;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  startedAt: string;
  completedAt: string | null;
  duration: number | null;
  tree: TaskNodeSummary;
  usage: {
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCacheTokens: number;
    estimatedCost: number;
    perStage: Record<string, UsageStats>;
    perSubtask: Record<number, UsageStats>;
  };
  gitInfo?: {
    branch: string;
    commitBefore: string;
    commitAfter: string | null;
    filesModified: string[];
  };
}

// --- CLI Options ---

export interface CliOptions {
  prompt: string;
  workDir: string;
  pipeline: string[];
  backend: RunnerBackend;
  permissionMode: PermissionMode;
  autoApprove: boolean;
  maxRetries: number;
  maxConcurrency: number;
  maxDepth: number;
  timeoutSeconds: number;
  noSummary: boolean;
  noMemory: boolean;
}
