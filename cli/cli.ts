/**
 * CLI entry point: arg parsing, terminal output, plan approval, run history.
 */

import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import type { CliOptions, RunnerBackend } from '../core/types.ts';
import { TaskOrchestrator, formatDuration } from '../core/taskOrchestrator.ts';
import { RunLogger } from '../core/runLogger.ts';
import { loadAndMergeStages } from '../core/configLoader.ts';
import { DagDisplay } from './dagDisplay.ts';

// --- Arg parsing (exported for testing) ---

export interface ParsedArgs extends CliOptions {
  subcommand?: 'runs';
  runsLast?: boolean;
}

const DEFAULTS = {
  pipeline: ['Plan', 'Execute', 'Verify'],
  backend: { type: 'cli' } as RunnerBackend,
  permissionMode: 'interactive' as const,
  maxRetries: 3,
  maxConcurrency: 3,
  maxDepth: 3,
  timeoutSeconds: 300,
  dagStages: ['Execute'],
};

export function parseArgs(argv: string[]): ParsedArgs {
  const args = [...argv];
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === '--workdir' || arg === '--work-dir') {
      flags.workDir = args[++i] ?? '';
    } else if (arg === '--backend') {
      flags.backend = args[++i] ?? '';
    } else if (arg === '--pipeline') {
      flags.pipeline = args[++i] ?? '';
    } else if (arg === '--timeout') {
      flags.timeout = args[++i] ?? '';
    } else if (arg === '--max-concurrency') {
      flags.maxConcurrency = args[++i] ?? '';
    } else if (arg === '--dag-stages') {
      flags.dagStages = args[++i] ?? '';
    } else if (arg === '--yolo') {
      flags.yolo = true;
    } else if (arg === '--auto-approve' || arg === '--auto-execute') {
      flags.autoApprove = true;
    } else if (arg === '--no-memory') {
      flags.noMemory = true;
    } else if (arg === '--no-summary') {
      flags.noSummary = true;
    } else if (arg === '--last') {
      flags.last = true;
    } else if (arg.startsWith('--')) {
      // skip unknown flags
    } else {
      positional.push(arg);
    }
    i++;
  }

  // Handle "runs" subcommand
  if (positional[0] === 'runs') {
    return {
      subcommand: 'runs',
      runsLast: flags.last === true,
      prompt: '',
      workDir: flags.workDir ? resolve(flags.workDir as string) : process.cwd(),
      pipeline: DEFAULTS.pipeline,
      backend: DEFAULTS.backend,
      permissionMode: DEFAULTS.permissionMode,
      autoApprove: false,
      maxRetries: DEFAULTS.maxRetries,
      maxConcurrency: DEFAULTS.maxConcurrency,
      maxDepth: DEFAULTS.maxDepth,
      timeoutSeconds: DEFAULTS.timeoutSeconds,
      noSummary: false,
      noMemory: false,
      dagStages: DEFAULTS.dagStages,
    };
  }

  const prompt = positional.join(' ');
  if (!prompt) {
    throw new Error('Prompt is required. Usage: dagclaw "your task description"');
  }

  // Validate backend
  const backendStr = (flags.backend as string) || 'cli';
  if (backendStr !== 'cli' && backendStr !== 'sdk') {
    throw new Error(`Unknown backend: "${backendStr}". Valid: cli, sdk`);
  }
  const backend: RunnerBackend = { type: backendStr };

  // Parse pipeline
  const pipeline = flags.pipeline
    ? (flags.pipeline as string).split(',').map(s => s.trim())
    : DEFAULTS.pipeline;

  return {
    prompt,
    workDir: flags.workDir ? resolve(flags.workDir as string) : process.cwd(),
    pipeline,
    backend,
    permissionMode: flags.yolo ? 'auto' as const
      : flags.autoApprove ? 'plan-only' as const
      : DEFAULTS.permissionMode,
    autoApprove: !!(flags.yolo || flags.autoApprove),
    maxRetries: DEFAULTS.maxRetries,
    maxConcurrency: flags.maxConcurrency
      ? parseInt(flags.maxConcurrency as string, 10)
      : DEFAULTS.maxConcurrency,
    maxDepth: DEFAULTS.maxDepth,
    timeoutSeconds: flags.timeout
      ? parseInt(flags.timeout as string, 10)
      : DEFAULTS.timeoutSeconds,
    noSummary: !!flags.noSummary,
    noMemory: !!flags.noMemory,
    dagStages: flags.dagStages
      ? (flags.dagStages as string).split(',').map(s => s.trim())
      : DEFAULTS.dagStages,
  };
}

// --- Terminal helpers ---

function log(msg: string) {
  process.stdout.write(msg + '\n');
}

function warn(msg: string) {
  process.stderr.write(`[warn] ${msg}\n`);
}

async function askYesNo(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase().startsWith('y'));
    });
  });
}

// --- Subcommands ---

function handleRuns(parsed: ParsedArgs): void {
  const logger = new RunLogger(parsed.workDir);
  const runs = logger.listRuns();

  if (runs.length === 0) {
    log('No runs found.');
    return;
  }

  if (parsed.runsLast) {
    const last = runs[0];
    log(`Run: ${last.id}`);
    log(`  Prompt:   ${last.prompt}`);
    log(`  Status:   ${last.status}`);
    log(`  Started:  ${last.startedAt}`);
    log(`  Duration: ${last.duration ? formatDuration(last.duration) : 'n/a'}`);
    log(`  Cost:     $${last.estimatedCost.toFixed(4)}`);
    return;
  }

  log(`Runs in ${parsed.workDir}:\n`);
  for (const run of runs) {
    const dur = run.duration ? formatDuration(run.duration) : '...';
    const cost = `$${run.estimatedCost.toFixed(4)}`;
    log(`  ${run.id}  ${run.status.padEnd(10)}  ${dur.padStart(8)}  ${cost.padStart(8)}  ${run.prompt.slice(0, 60)}`);
  }
}

// --- Main ---

async function main() {
  const parsed = parseArgs(process.argv.slice(2));

  if (parsed.subcommand === 'runs') {
    handleRuns(parsed);
    return;
  }

  let stageRegistry;
  try {
    stageRegistry = await loadAndMergeStages(parsed.workDir);
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    warn(`Failed to load dagclaw config: ${errMsg}. Using built-in stages only.`);
    stageRegistry = undefined;
  }

  if (stageRegistry) {
    for (const stageName of parsed.pipeline) {
      if (!stageRegistry[stageName]) {
        throw new Error(
          `Unknown stage "${stageName}" in pipeline. Available: ${Object.keys(stageRegistry).join(', ')}`
        );
      }
    }
  }

  const dagDisplay = new DagDisplay(process.stdout);

  const dagAwareLog = (msg: string) => {
    if (dagDisplay.isActive()) {
      dagDisplay.writeStatus(msg);
    } else {
      log(msg);
    }
  };

  const orchestrator = new TaskOrchestrator(parsed, {
    onStatus: dagAwareLog,
    onWarning: warn,
    onApprovalRequest: askYesNo,
    onDAGEvent: (event) => dagDisplay.handleEvent(event),
    onStageStart: (label) => dagDisplay.stageStart(label),
    onStageEnd: () => dagDisplay.stageEnd(),
  }, 0, undefined, stageRegistry);

  orchestrator.setupSignalHandlers();

  try {
    const { runId, success } = await orchestrator.run();
    if (success) {
      log(`\nRun ${runId} completed successfully.`);
    } else {
      log(`\nRun ${runId} was cancelled.`);
      process.exitCode = 1;
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`\nFatal: ${msg}\n`);
    process.exitCode = 1;
  }
}

// Only run when invoked as entry point (not when imported for testing)
const isEntryPoint = process.argv[1]?.endsWith('cli.ts') || process.argv[1]?.endsWith('claw.js') || process.argv[1]?.endsWith('dagclaw.js');
if (isEntryPoint) {
  main();
}
