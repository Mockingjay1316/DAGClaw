import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { StageDefinition } from '../types.ts';

// The module under test (will be implemented at src/configLoader.ts)
import {
  loadCustomStages,
  mergeStages,
  validateStageDefinition,
} from '../configLoader.ts';

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'claw-config-test-'));
}

function cleanupDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/** Minimal valid stage definition for JSON config (template-based handlers). */
function makeMinimalJsonStage(overrides?: Record<string, unknown>) {
  return {
    name: 'CustomLint',
    runnerConfig: {
      systemPrompt: 'You are a linter.',
      promptTemplate: 'Lint the code in {{workDir}}.',
    },
    contextBuilder: {
      type: 'template',
      mapping: { workDir: 'state.workDir' },
    },
    resultHandler: {
      type: 'template',
      template: 'Lint completed: {{summary}}',
    },
    ...overrides,
  };
}

/** A full StageDefinition with real functions (for mergeStages / TS config tests). */
function makeFullStageDefinition(name: string): StageDefinition {
  return {
    name,
    runnerConfig: {
      systemPrompt: `You are the ${name} stage.`,
      promptTemplate: `Run ${name} on {{workDir}}.`,
    },
    contextBuilder: (_state, _outputFile) => ({ workDir: _state.workDir }),
    resultHandler: (_state, _parsed) => `${name} done`,
  };
}

/** Fake built-in stages for merge tests. */
function fakeBuiltins(): Record<string, StageDefinition> {
  return {
    Plan: makeFullStageDefinition('Plan'),
    Execute: makeFullStageDefinition('Execute'),
    Verify: makeFullStageDefinition('Verify'),
  };
}

describe('configLoader', () => {
  // ---------------------------------------------------------------
  // 1. loadCustomStages returns empty record when no config file
  // ---------------------------------------------------------------
  describe('loadCustomStages – no config file', () => {
    it('returns empty record when no config file exists', async () => {
      const dir = makeTmpDir();
      try {
        const stages = await loadCustomStages(dir);
        assert.deepStrictEqual(stages, {});
      } finally {
        cleanupDir(dir);
      }
    });
  });

  // ---------------------------------------------------------------
  // 2. loadCustomStages loads stages from dagclaw.config.json
  // ---------------------------------------------------------------
  describe('loadCustomStages – dagclaw.config.json', () => {
    it('loads and returns stages from a valid JSON config', async () => {
      const dir = makeTmpDir();
      try {
        const config = {
          stages: {
            CustomLint: makeMinimalJsonStage(),
          },
        };
        writeFileSync(
          join(dir, 'dagclaw.config.json'),
          JSON.stringify(config, null, 2),
        );

        const stages = await loadCustomStages(dir);

        assert.ok('CustomLint' in stages, 'CustomLint stage should be loaded');
        assert.equal(stages.CustomLint.name, 'CustomLint');
        assert.equal(
          stages.CustomLint.runnerConfig.systemPrompt,
          'You are a linter.',
        );
        assert.equal(
          stages.CustomLint.runnerConfig.promptTemplate,
          'Lint the code in {{workDir}}.',
        );
      } finally {
        cleanupDir(dir);
      }
    });

    it('loads multiple custom stages from JSON config', async () => {
      const dir = makeTmpDir();
      try {
        const config = {
          stages: {
            Lint: makeMinimalJsonStage({ name: 'Lint' }),
            Format: makeMinimalJsonStage({
              name: 'Format',
              runnerConfig: {
                systemPrompt: 'You are a formatter.',
                promptTemplate: 'Format {{workDir}}.',
              },
            }),
          },
        };
        writeFileSync(
          join(dir, 'dagclaw.config.json'),
          JSON.stringify(config, null, 2),
        );

        const stages = await loadCustomStages(dir);

        assert.ok('Lint' in stages);
        assert.ok('Format' in stages);
        assert.equal(stages.Format.runnerConfig.systemPrompt, 'You are a formatter.');
      } finally {
        cleanupDir(dir);
      }
    });
  });

  // ---------------------------------------------------------------
  // 3. loadCustomStages loads stages from dagclaw.config.ts
  // ---------------------------------------------------------------
  describe('loadCustomStages – dagclaw.config.ts', () => {
    it('loads stages from a TypeScript config via dynamic import', async () => {
      const dir = makeTmpDir();
      try {
        // Write a TS config that exports a default with stages
        const tsContent = `
export default {
  stages: {
    Deploy: {
      name: 'Deploy',
      runnerConfig: {
        systemPrompt: 'You are a deployer.',
        promptTemplate: 'Deploy to {{env}}.',
      },
      contextBuilder: (state: any, outputFile: string) => ({ env: 'production' }),
      resultHandler: (state: any, parsed: any) => 'Deployed successfully',
    },
  },
};
`;
        writeFileSync(join(dir, 'dagclaw.config.ts'), tsContent);

        const stages = await loadCustomStages(dir);

        assert.ok('Deploy' in stages, 'Deploy stage should be loaded from TS config');
        assert.equal(stages.Deploy.name, 'Deploy');
        assert.equal(
          stages.Deploy.runnerConfig.systemPrompt,
          'You are a deployer.',
        );
        // contextBuilder should be a real function from the TS config
        assert.equal(typeof stages.Deploy.contextBuilder, 'function');
        assert.equal(typeof stages.Deploy.resultHandler, 'function');
      } finally {
        cleanupDir(dir);
      }
    });

    it('prefers dagclaw.config.ts over dagclaw.config.json when both exist', async () => {
      const dir = makeTmpDir();
      try {
        // Write JSON config
        const jsonConfig = {
          stages: {
            FromJson: makeMinimalJsonStage({ name: 'FromJson' }),
          },
        };
        writeFileSync(
          join(dir, 'dagclaw.config.json'),
          JSON.stringify(jsonConfig, null, 2),
        );

        // Write TS config
        const tsContent = `
export default {
  stages: {
    FromTs: {
      name: 'FromTs',
      runnerConfig: {
        systemPrompt: 'TS stage.',
        promptTemplate: 'Run {{task}}.',
      },
      contextBuilder: (state: any, outputFile: string) => ({ task: 'test' }),
      resultHandler: (state: any, parsed: any) => 'done',
    },
  },
};
`;
        writeFileSync(join(dir, 'dagclaw.config.ts'), tsContent);

        const stages = await loadCustomStages(dir);

        // TS config should take precedence
        assert.ok('FromTs' in stages, 'Should load from TS config');
        assert.ok(!('FromJson' in stages), 'Should NOT load from JSON when TS exists');
      } finally {
        cleanupDir(dir);
      }
    });
  });

  // ---------------------------------------------------------------
  // 4. loadCustomStages throws/warns on invalid stage definition
  // ---------------------------------------------------------------
  describe('loadCustomStages – invalid config', () => {
    it('throws on stage missing required name field', async () => {
      const dir = makeTmpDir();
      try {
        const config = {
          stages: {
            Bad: {
              // name is missing
              runnerConfig: {
                systemPrompt: 'Hello.',
                promptTemplate: 'Do {{thing}}.',
              },
              contextBuilder: { type: 'template', mapping: {} },
              resultHandler: { type: 'template', template: '{{result}}' },
            },
          },
        };
        writeFileSync(
          join(dir, 'dagclaw.config.json'),
          JSON.stringify(config, null, 2),
        );

        await assert.rejects(
          () => loadCustomStages(dir),
          (err: Error) => {
            assert.ok(
              err.message.includes('name') || err.message.includes('invalid') || err.message.includes('Invalid'),
              `Error should mention missing 'name', got: ${err.message}`,
            );
            return true;
          },
        );
      } finally {
        cleanupDir(dir);
      }
    });

    it('throws on stage missing runnerConfig', async () => {
      const dir = makeTmpDir();
      try {
        const config = {
          stages: {
            Bad: {
              name: 'Bad',
              // runnerConfig is missing
              contextBuilder: { type: 'template', mapping: {} },
              resultHandler: { type: 'template', template: '{{result}}' },
            },
          },
        };
        writeFileSync(
          join(dir, 'dagclaw.config.json'),
          JSON.stringify(config, null, 2),
        );

        await assert.rejects(
          () => loadCustomStages(dir),
          (err: Error) => {
            assert.ok(
              err.message.includes('runnerConfig') || err.message.includes('invalid') || err.message.includes('Invalid'),
              `Error should mention missing 'runnerConfig', got: ${err.message}`,
            );
            return true;
          },
        );
      } finally {
        cleanupDir(dir);
      }
    });

    it('throws on runnerConfig missing systemPrompt', async () => {
      const dir = makeTmpDir();
      try {
        const config = {
          stages: {
            Bad: {
              name: 'Bad',
              runnerConfig: {
                // systemPrompt missing
                promptTemplate: 'Do {{thing}}.',
              },
              contextBuilder: { type: 'template', mapping: {} },
              resultHandler: { type: 'template', template: '{{result}}' },
            },
          },
        };
        writeFileSync(
          join(dir, 'dagclaw.config.json'),
          JSON.stringify(config, null, 2),
        );

        await assert.rejects(
          () => loadCustomStages(dir),
          (err: Error) => {
            assert.ok(
              err.message.includes('systemPrompt') || err.message.includes('invalid') || err.message.includes('Invalid'),
              `Error should mention missing 'systemPrompt', got: ${err.message}`,
            );
            return true;
          },
        );
      } finally {
        cleanupDir(dir);
      }
    });
  });

  // ---------------------------------------------------------------
  // 5. mergeStages merges custom stages with built-in stages
  // ---------------------------------------------------------------
  describe('mergeStages', () => {
    it('merges custom stages with built-in stages', () => {
      const builtins = fakeBuiltins();
      const custom: Record<string, StageDefinition> = {
        Lint: makeFullStageDefinition('Lint'),
        Deploy: makeFullStageDefinition('Deploy'),
      };

      const merged = mergeStages(builtins, custom);

      // All built-ins still present
      assert.ok('Plan' in merged);
      assert.ok('Execute' in merged);
      assert.ok('Verify' in merged);
      // Custom stages added
      assert.ok('Lint' in merged);
      assert.ok('Deploy' in merged);
      // Total count
      assert.equal(Object.keys(merged).length, 5);
    });

    it('custom stages are accessible by name from merged result', () => {
      const builtins = fakeBuiltins();
      const custom: Record<string, StageDefinition> = {
        Lint: makeFullStageDefinition('Lint'),
      };

      const merged = mergeStages(builtins, custom);

      assert.equal(merged.Lint.name, 'Lint');
      assert.equal(
        merged.Lint.runnerConfig.systemPrompt,
        'You are the Lint stage.',
      );
    });

    it('returns only builtins when custom is empty', () => {
      const builtins = fakeBuiltins();
      const merged = mergeStages(builtins, {});

      assert.equal(Object.keys(merged).length, 3);
      assert.ok('Plan' in merged);
    });
  });

  // ---------------------------------------------------------------
  // 6. mergeStages throws on reserved name without override flag
  // ---------------------------------------------------------------
  describe('mergeStages – reserved name protection', () => {
    it('throws if custom stage uses reserved name "Plan" without override flag', () => {
      const builtins = fakeBuiltins();
      const custom: Record<string, StageDefinition> = {
        Plan: makeFullStageDefinition('Plan'),
      };

      assert.throws(
        () => mergeStages(builtins, custom),
        (err: Error) => {
          assert.ok(
            err.message.includes('Plan') && (err.message.includes('reserved') || err.message.includes('override') || err.message.includes('built-in')),
            `Error should mention reserved name 'Plan', got: ${err.message}`,
          );
          return true;
        },
      );
    });

    it('throws if custom stage uses reserved name "Execute" without override flag', () => {
      const builtins = fakeBuiltins();
      const custom: Record<string, StageDefinition> = {
        Execute: makeFullStageDefinition('Execute'),
      };

      assert.throws(
        () => mergeStages(builtins, custom),
        (err: Error) => {
          assert.ok(
            err.message.includes('Execute'),
            `Error should mention 'Execute', got: ${err.message}`,
          );
          return true;
        },
      );
    });

    it('throws if custom stage uses reserved name "Verify" without override flag', () => {
      const builtins = fakeBuiltins();
      const custom: Record<string, StageDefinition> = {
        Verify: makeFullStageDefinition('Verify'),
      };

      assert.throws(
        () => mergeStages(builtins, custom),
        (err: Error) => {
          assert.ok(
            err.message.includes('Verify'),
            `Error should mention 'Verify', got: ${err.message}`,
          );
          return true;
        },
      );
    });

    it('allows overriding a built-in name when override flag is set', () => {
      const builtins = fakeBuiltins();
      const customPlan = makeFullStageDefinition('Plan');
      // Add the explicit override flag
      const custom: Record<string, StageDefinition & { overrideBuiltin?: boolean }> = {
        Plan: { ...customPlan, overrideBuiltin: true } as StageDefinition & { overrideBuiltin: boolean },
      };

      const merged = mergeStages(builtins, custom);

      // The custom Plan should replace the built-in
      assert.equal(
        merged.Plan.runnerConfig.systemPrompt,
        'You are the Plan stage.',
      );
    });
  });

  // ---------------------------------------------------------------
  // 7. validateStageDefinition validates required fields
  // ---------------------------------------------------------------
  describe('validateStageDefinition', () => {
    it('accepts a valid StageDefinition object', () => {
      const stage = makeFullStageDefinition('Lint');
      const result = validateStageDefinition(stage);
      assert.equal(result.valid, true);
      assert.deepStrictEqual(result.errors, []);
    });

    it('rejects missing name', () => {
      const stage = makeFullStageDefinition('Lint');
      const noName = { ...stage, name: undefined };
      const result = validateStageDefinition(noName);
      assert.equal(result.valid, false);
      assert.ok(
        result.errors.some((e: string) => e.includes('name')),
        `Should report missing 'name', got: ${result.errors}`,
      );
    });

    it('rejects missing runnerConfig.systemPrompt', () => {
      const stage = makeFullStageDefinition('Lint');
      const bad = {
        ...stage,
        runnerConfig: { promptTemplate: 'ok' },
      };
      const result = validateStageDefinition(bad);
      assert.equal(result.valid, false);
      assert.ok(
        result.errors.some((e: string) => e.includes('systemPrompt')),
        `Should report missing 'systemPrompt', got: ${result.errors}`,
      );
    });

    it('rejects missing runnerConfig.promptTemplate', () => {
      const stage = makeFullStageDefinition('Lint');
      const bad = {
        ...stage,
        runnerConfig: { systemPrompt: 'ok' },
      };
      const result = validateStageDefinition(bad);
      assert.equal(result.valid, false);
      assert.ok(
        result.errors.some((e: string) => e.includes('promptTemplate')),
        `Should report missing 'promptTemplate', got: ${result.errors}`,
      );
    });

    it('rejects missing runnerConfig entirely', () => {
      const stage = makeFullStageDefinition('Lint');
      const bad = { ...stage, runnerConfig: undefined };
      const result = validateStageDefinition(bad);
      assert.equal(result.valid, false);
      assert.ok(
        result.errors.some((e: string) => e.includes('runnerConfig')),
        `Should report missing 'runnerConfig', got: ${result.errors}`,
      );
    });

    it('rejects missing contextBuilder', () => {
      const stage = makeFullStageDefinition('Lint');
      const bad = { ...stage, contextBuilder: undefined };
      const result = validateStageDefinition(bad);
      assert.equal(result.valid, false);
      assert.ok(
        result.errors.some((e: string) => e.includes('contextBuilder')),
        `Should report missing 'contextBuilder', got: ${result.errors}`,
      );
    });

    it('rejects missing resultHandler', () => {
      const stage = makeFullStageDefinition('Lint');
      const bad = { ...stage, resultHandler: undefined };
      const result = validateStageDefinition(bad);
      assert.equal(result.valid, false);
      assert.ok(
        result.errors.some((e: string) => e.includes('resultHandler')),
        `Should report missing 'resultHandler', got: ${result.errors}`,
      );
    });

    it('reports multiple missing fields at once', () => {
      const result = validateStageDefinition({});
      assert.equal(result.valid, false);
      // Should report at least name, runnerConfig, contextBuilder, resultHandler
      assert.ok(
        result.errors.length >= 4,
        `Should report at least 4 errors, got ${result.errors.length}: ${result.errors}`,
      );
    });

    it('accepts a JSON-config style stage with template-based handlers', () => {
      const jsonStage = makeMinimalJsonStage();
      const result = validateStageDefinition(jsonStage);
      assert.equal(result.valid, true);
      assert.deepStrictEqual(result.errors, []);
    });
  });
});
