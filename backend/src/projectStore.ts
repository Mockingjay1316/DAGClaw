import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export interface Project {
  id: string;
  name: string;
  path: string;
  addedAt: string;
}

interface ProjectsFile {
  projects: Project[];
}

/**
 * Manages project CRUD operations with persistence to ~/.dagclaw/server/projects.json.
 * A project is a filesystem path with a .dagclaw/ directory.
 */
export class ProjectStore {
  private projects = new Map<string, Project>();
  private filePath: string;

  constructor(baseDir?: string) {
    const home = baseDir ?? process.env.HOME ?? '/tmp';
    const dir = path.join(home, '.dagclaw', 'server');
    this.filePath = path.join(dir, 'projects.json');
    this.load(dir);
  }

  private load(dir: string): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        const data: ProjectsFile = JSON.parse(raw);
        for (const p of data.projects) {
          this.projects.set(p.id, p);
        }
      }
    } catch {
      // Start fresh if file is corrupt
    }
    // Ensure directory exists for future writes
    fs.mkdirSync(dir, { recursive: true });
  }

  private save(): void {
    const data: ProjectsFile = { projects: Array.from(this.projects.values()) };
    fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2), 'utf-8');
  }

  /** Add a project by filesystem path. Creates .dagclaw/ if needed. */
  addProject(projectPath: string, name?: string): Project {
    const resolved = path.resolve(projectPath);

    // Validate path exists
    if (!fs.existsSync(resolved)) {
      throw new Error(`Path does not exist: ${resolved}`);
    }
    if (!fs.statSync(resolved).isDirectory()) {
      throw new Error(`Path is not a directory: ${resolved}`);
    }

    // Check for duplicate path
    for (const p of this.projects.values()) {
      if (p.path === resolved) {
        throw new Error(`Project already exists for path: ${resolved}`);
      }
    }

    // Ensure .dagclaw/ exists
    const dagclawDir = path.join(resolved, '.dagclaw');
    fs.mkdirSync(dagclawDir, { recursive: true });

    const project: Project = {
      id: crypto.randomUUID(),
      name: name ?? path.basename(resolved),
      path: resolved,
      addedAt: new Date().toISOString(),
    };

    this.projects.set(project.id, project);
    this.save();
    return project;
  }

  /** Remove a project from the list (does NOT delete .dagclaw/ directory). */
  removeProject(id: string): boolean {
    const removed = this.projects.delete(id);
    if (removed) this.save();
    return removed;
  }

  /** Get all projects. */
  listProjects(): Project[] {
    return Array.from(this.projects.values());
  }

  /** Get a single project by id. */
  getProject(id: string): Project | undefined {
    return this.projects.get(id);
  }

  /** Find project by filesystem path. */
  getProjectByPath(projectPath: string): Project | undefined {
    const resolved = path.resolve(projectPath);
    for (const p of this.projects.values()) {
      if (p.path === resolved) return p;
    }
    return undefined;
  }
}
