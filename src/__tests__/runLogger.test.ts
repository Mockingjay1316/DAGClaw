import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { RunLogger } from '../runLogger.ts';
import type { UsageStats, Plan, VerificationResult } from '../types.ts';

let tmpDir: string;

function makeUsageStats(overrides?: Partial<UsageStats>): UsageStats {
  return {
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    estimatedCost: 0.01,
    durationMs: 1000,
    ...overrides,
  };
}

describe('RunLogger', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('initRun', () => {
    it('creates .claw/runs/<runId>/ directory', () => {
      const logger = new RunLogger(tmpDir);
      const runId = logger.initRun({
        prompt: 'test task',
        pipeline: ['Plan', 'Execute', 'Verify'],
        backend: 'sdk',
        permissionMode: 'interactive',
      });

      assert.ok(runId.length > 0);
      const runDir = path.join(tmpDir, '.claw', 'runs', runId);
      assert.ok(fs.existsSync(runDir));
    });

    it('writes initial manifest.json', () => {
      const logger = new RunLogger(tmpDir);
      const runId = logger.initRun({
        prompt: 'test task',
        pipeline: ['Plan', 'Execute', 'Verify'],
        backend: 'sdk',
        permissionMode: 'interactive',
      });

      const manifest = logger.readManifest(runId);
      assert.equal(manifest.prompt, 'test task');
      assert.equal(manifest.status, 'running');
      assert.deepEqual(manifest.pipeline, ['Plan', 'Execute', 'Verify']);
      assert.equal(manifest.backend, 'sdk');
      assert.equal(manifest.completedAt, null);
    });
  });

  describe('updateManifestStatus', () => {
    it('updates status and completedAt', () => {
      const logger = new RunLogger(tmpDir);
      const runId = logger.initRun({
        prompt: 'test',
        pipeline: ['Plan'],
        backend: 'sdk',
        permissionMode: 'interactive',
      });

      logger.updateManifestStatus(runId, 'completed');

      const manifest = logger.readManifest(runId);
      assert.equal(manifest.status, 'completed');
      assert.ok(manifest.completedAt !== null);
      assert.ok(manifest.duration !== null);
    });
  });

  describe('writePlan', () => {
    it('writes plan.json to run directory', () => {
      const logger = new RunLogger(tmpDir);
      const runId = logger.initRun({
        prompt: 'test',
        pipeline: ['Plan'],
        backend: 'sdk',
        permissionMode: 'interactive',
      });

      const plan: Plan = {
        summary: 'Test plan',
        subtasks: [
          {
            index: 0,
            description: 'do thing',
            prompt: 'do the thing',
            dependencies: [],
            estimatedComplexity: 'low',
            needsRecursiveDecomposition: false,
          },
        ],
        worthDistilling: false,
      };

      logger.writePlan(runId, plan);

      const planPath = path.join(
        tmpDir, '.claw', 'runs', runId, 'plan.json'
      );
      assert.ok(fs.existsSync(planPath));
      const written = JSON.parse(fs.readFileSync(planPath, 'utf-8'));
      assert.equal(written.summary, 'Test plan');
    });
  });

  describe('appendSubtaskLog', () => {
    it('creates subtask log file and appends data', () => {
      const logger = new RunLogger(tmpDir);
      const runId = logger.initRun({
        prompt: 'test',
        pipeline: ['Execute'],
        backend: 'sdk',
        permissionMode: 'interactive',
      });

      logger.appendSubtaskLog(runId, 0, 'line 1\n');
      logger.appendSubtaskLog(runId, 0, 'line 2\n');

      const logPath = path.join(
        tmpDir, '.claw', 'runs', runId, 'subtasks', '0.log'
      );
      assert.ok(fs.existsSync(logPath));
      const content = fs.readFileSync(logPath, 'utf-8');
      assert.equal(content, 'line 1\nline 2\n');
    });
  });

  describe('updateSubtaskUsage', () => {
    it('updates per-subtask usage in manifest', () => {
      const logger = new RunLogger(tmpDir);
      const runId = logger.initRun({
        prompt: 'test',
        pipeline: ['Execute'],
        backend: 'sdk',
        permissionMode: 'interactive',
      });

      logger.updateSubtaskUsage(runId, 0, makeUsageStats({ inputTokens: 200 }));

      const manifest = logger.readManifest(runId);
      assert.equal(manifest.usage.perSubtask[0].inputTokens, 200);
      assert.equal(manifest.usage.totalInputTokens, 200);
    });
  });

  describe('updateStageUsage', () => {
    it('updates per-stage usage in manifest', () => {
      const logger = new RunLogger(tmpDir);
      const runId = logger.initRun({
        prompt: 'test',
        pipeline: ['Plan'],
        backend: 'sdk',
        permissionMode: 'interactive',
      });

      logger.updateStageUsage(runId, 'Plan', makeUsageStats({ outputTokens: 300 }));

      const manifest = logger.readManifest(runId);
      assert.equal(manifest.usage.perStage['Plan'].outputTokens, 300);
    });
  });

  describe('writeVerification', () => {
    it('writes verification.json to run directory', () => {
      const logger = new RunLogger(tmpDir);
      const runId = logger.initRun({
        prompt: 'test',
        pipeline: ['Verify'],
        backend: 'sdk',
        permissionMode: 'interactive',
      });

      const result: VerificationResult = {
        overallPass: true,
        subtaskResults: [
          { subtaskIndex: 0, pass: true, summary: 'ok', retryRecommended: false },
        ],
        skippedIndices: [],
        integrationResult: { pass: true, summary: 'all good', issues: [] },
      };

      logger.writeVerification(runId, result);

      const verifyPath = path.join(
        tmpDir, '.claw', 'runs', runId, 'verification.json'
      );
      assert.ok(fs.existsSync(verifyPath));
    });
  });

  describe('listRuns', () => {
    it('returns all runs', () => {
      const logger = new RunLogger(tmpDir);
      const id1 = logger.initRun({
        prompt: 'first',
        pipeline: ['Plan'],
        backend: 'sdk',
        permissionMode: 'interactive',
      });
      const id2 = logger.initRun({
        prompt: 'second',
        pipeline: ['Plan'],
        backend: 'sdk',
        permissionMode: 'interactive',
      });

      const runs = logger.listRuns();
      assert.equal(runs.length, 2);
      const ids = runs.map((r) => r.id).sort();
      assert.deepEqual(ids, [id1, id2].sort());
    });

    it('returns empty array when no runs', () => {
      const logger = new RunLogger(tmpDir);
      assert.deepEqual(logger.listRuns(), []);
    });
  });

  describe('cleanTmp', () => {
    it('cleans .claw/tmp/ directory', () => {
      const logger = new RunLogger(tmpDir);
      const tmpClaw = path.join(tmpDir, '.claw', 'tmp');
      fs.mkdirSync(tmpClaw, { recursive: true });
      fs.writeFileSync(path.join(tmpClaw, 'plan.json'), '{}');

      logger.cleanTmp();

      assert.ok(fs.existsSync(tmpClaw)); // dir still exists
      assert.equal(fs.readdirSync(tmpClaw).length, 0); // but empty
    });
  });
});
