import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ProjectStore } from '../src/projectStore.ts';

let tmpDir: string;

function setup(): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dagclaw-test-'));
  return tmpDir;
}

function cleanup(): void {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
}

describe('ProjectStore', () => {
  beforeEach(() => setup());
  afterEach(() => cleanup());

  it('starts with empty project list', () => {
    const store = new ProjectStore(tmpDir);
    assert.deepEqual(store.listProjects(), []);
  });

  it('addProject creates a project and persists it', () => {
    const projectDir = path.join(tmpDir, 'myproject');
    fs.mkdirSync(projectDir);

    const store = new ProjectStore(tmpDir);
    const project = store.addProject(projectDir, 'My Project');

    assert.equal(project.name, 'My Project');
    assert.equal(project.path, projectDir);
    assert.ok(project.id);
    assert.ok(project.addedAt);

    // Verify persistence
    const store2 = new ProjectStore(tmpDir);
    const projects = store2.listProjects();
    assert.equal(projects.length, 1);
    assert.equal(projects[0].name, 'My Project');
  });

  it('addProject defaults name to directory basename', () => {
    const projectDir = path.join(tmpDir, 'cool-project');
    fs.mkdirSync(projectDir);

    const store = new ProjectStore(tmpDir);
    const project = store.addProject(projectDir);
    assert.equal(project.name, 'cool-project');
  });

  it('addProject creates .dagclaw directory', () => {
    const projectDir = path.join(tmpDir, 'newproj');
    fs.mkdirSync(projectDir);

    const store = new ProjectStore(tmpDir);
    store.addProject(projectDir);

    assert.ok(fs.existsSync(path.join(projectDir, '.dagclaw')));
  });

  it('addProject throws for non-existent path', () => {
    const store = new ProjectStore(tmpDir);
    assert.throws(
      () => store.addProject('/nonexistent/path/xyz'),
      /does not exist/,
    );
  });

  it('addProject throws for duplicate path', () => {
    const projectDir = path.join(tmpDir, 'dup');
    fs.mkdirSync(projectDir);

    const store = new ProjectStore(tmpDir);
    store.addProject(projectDir);
    assert.throws(
      () => store.addProject(projectDir),
      /already exists/,
    );
  });

  it('addProject throws for file path (not directory)', () => {
    const filePath = path.join(tmpDir, 'file.txt');
    fs.writeFileSync(filePath, 'hello');

    const store = new ProjectStore(tmpDir);
    assert.throws(
      () => store.addProject(filePath),
      /not a directory/,
    );
  });

  it('removeProject removes from list', () => {
    const projectDir = path.join(tmpDir, 'removeme');
    fs.mkdirSync(projectDir);

    const store = new ProjectStore(tmpDir);
    const project = store.addProject(projectDir);

    assert.equal(store.removeProject(project.id), true);
    assert.equal(store.listProjects().length, 0);

    // .dagclaw should still exist
    assert.ok(fs.existsSync(path.join(projectDir, '.dagclaw')));
  });

  it('removeProject returns false for unknown id', () => {
    const store = new ProjectStore(tmpDir);
    assert.equal(store.removeProject('nonexistent'), false);
  });

  it('getProject returns project by id', () => {
    const projectDir = path.join(tmpDir, 'getme');
    fs.mkdirSync(projectDir);

    const store = new ProjectStore(tmpDir);
    const project = store.addProject(projectDir);

    const found = store.getProject(project.id);
    assert.ok(found);
    assert.equal(found.id, project.id);
  });

  it('getProject returns undefined for unknown id', () => {
    const store = new ProjectStore(tmpDir);
    assert.equal(store.getProject('unknown'), undefined);
  });

  it('getProjectByPath returns project by path', () => {
    const projectDir = path.join(tmpDir, 'bypath');
    fs.mkdirSync(projectDir);

    const store = new ProjectStore(tmpDir);
    const project = store.addProject(projectDir);

    const found = store.getProjectByPath(projectDir);
    assert.ok(found);
    assert.equal(found.id, project.id);
  });

  it('getProjectByPath returns undefined for unknown path', () => {
    const store = new ProjectStore(tmpDir);
    assert.equal(store.getProjectByPath('/unknown'), undefined);
  });
});
