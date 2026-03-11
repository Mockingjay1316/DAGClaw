import { create } from 'zustand';
import type { Project } from '../types.ts';

interface ProjectState {
  projects: Project[];
  selectedProjectId: string | null;
  loading: boolean;
  error: string | null;

  fetchProjects: () => Promise<void>;
  addProject: (path: string, name?: string) => Promise<Project | null>;
  removeProject: (id: string) => Promise<boolean>;
  selectProject: (id: string | null) => void;
  updateProjectCounts: (projectId: string, taskCounts: Record<string, number>) => void;
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  projects: [],
  selectedProjectId: null,
  loading: false,
  error: null,

  fetchProjects: async () => {
    set({ loading: true, error: null });
    try {
      const res = await fetch('/api/projects');
      if (!res.ok) throw new Error(`Failed to fetch projects: ${res.status}`);
      const projects: Project[] = await res.json();
      set({ projects, loading: false });
      // Auto-select first project if none selected
      if (!get().selectedProjectId && projects.length > 0) {
        set({ selectedProjectId: projects[0].id });
      }
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Unknown error', loading: false });
    }
  },

  addProject: async (path: string, name?: string) => {
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, name: name || undefined }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: `Request failed: ${res.status}` }));
        set({ error: body.error || 'Failed to add project' });
        return null;
      }
      const project: Project = await res.json();
      set((state) => ({
        projects: [...state.projects, project],
        selectedProjectId: project.id,
        error: null,
      }));
      return project;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Unknown error' });
      return null;
    }
  },

  removeProject: async (id: string) => {
    try {
      const res = await fetch(`/api/projects/${id}`, { method: 'DELETE' });
      if (!res.ok) return false;
      set((state) => {
        const projects = state.projects.filter((p) => p.id !== id);
        const selectedProjectId =
          state.selectedProjectId === id
            ? projects.length > 0 ? projects[0].id : null
            : state.selectedProjectId;
        return { projects, selectedProjectId };
      });
      return true;
    } catch {
      return false;
    }
  },

  selectProject: (id: string | null) => {
    set({ selectedProjectId: id });
  },

  updateProjectCounts: (projectId: string, taskCounts: Record<string, number>) => {
    set((state) => ({
      projects: state.projects.map((p) =>
        p.id === projectId ? { ...p, taskCounts } : p
      ),
    }));
  },
}));

// Selectors
export const selectProjects = (state: ProjectState) => state.projects;
export const selectSelectedProjectId = (state: ProjectState) => state.selectedProjectId;
export const selectSelectedProject = (state: ProjectState) =>
  state.projects.find((p) => p.id === state.selectedProjectId);
