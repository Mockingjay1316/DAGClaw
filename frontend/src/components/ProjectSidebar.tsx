import { useEffect, useState } from 'react';
import { useProjectStore } from '../stores/projectStore.ts';
import { useOrchestratorStore } from '../stores/orchestratorStore.ts';
import { useWebSocket } from '../hooks/useWebSocket.ts';
import { subscribe } from '../hooks/useWebSocket.ts';

export function ProjectSidebar() {
  const projects = useProjectStore((s) => s.projects);
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId);
  const fetchProjects = useProjectStore((s) => s.fetchProjects);
  const addProject = useProjectStore((s) => s.addProject);
  const removeProject = useProjectStore((s) => s.removeProject);
  const selectProject = useProjectStore((s) => s.selectProject);
  const error = useProjectStore((s) => s.error);

  const setRootTasks = useOrchestratorStore((s) => s.setRootTasks);
  const appendTasks = useOrchestratorStore((s) => s.appendTasks);
  const fetchUsage = useOrchestratorStore((s) => s.fetchUsage);
  const { subscribeProject, unsubscribeProject } = useWebSocket();

  const [showAdd, setShowAdd] = useState(false);
  const [newPath, setNewPath] = useState('');
  const [addError, setAddError] = useState<string | null>(null);

  useEffect(() => {
    fetchProjects();
  }, [fetchProjects]);

  // Fetch tasks via HTTP on project select, then subscribe WS for live updates
  useEffect(() => {
    if (selectedProjectId) {
      // Reset rootTasks for new project
      setRootTasks([]);

      // WS subscription sends active tasks (todo, queued, running, awaiting_approval, pending)
      // plus counts for all statuses. Terminal tasks are fetched paginated via REST.
      subscribeProject(selectedProjectId);

      // Fetch first 10 terminal tasks per status (paginated)
      const terminalStatuses = ['completed', 'failed', 'cancelled'];
      for (const status of terminalStatuses) {
        fetch(`/api/projects/${selectedProjectId}/tasks?status=${status}&limit=10&offset=0`)
          .then(res => res.ok ? res.json() : null)
          .then((data: { tasks: Parameters<typeof appendTasks>[0]; total: number } | null) => {
            if (data?.tasks) {
              appendTasks(data.tasks);
              // Eagerly fetch usage/cost for terminal tasks
              for (const t of data.tasks) {
                if ((t.status === 'completed' || t.status === 'failed') && t.runId) {
                  fetchUsage(t.id);
                }
              }
              // Auto-subscribe to running tasks if any (shouldn't be for terminal, but safe)
              const activeIds = data.tasks
                .filter((t: { status: string }) => t.status === 'running' || t.status === 'awaiting_approval')
                .map((t: { id: string }) => t.id);
              if (activeIds.length > 0) subscribe(activeIds);
            }
          })
          .catch(() => { /* silently ignore */ });
      }

      return () => unsubscribeProject(selectedProjectId);
    }
  }, [selectedProjectId, subscribeProject, unsubscribeProject, setRootTasks, appendTasks, fetchUsage]);

  async function handleAddProject(e: React.FormEvent) {
    e.preventDefault();
    if (!newPath.trim()) return;
    setAddError(null);
    const result = await addProject(newPath.trim());
    if (result) {
      setNewPath('');
      setShowAdd(false);
    } else {
      setAddError(useProjectStore.getState().error || 'Failed to add project');
    }
  }

  function handleRemove(e: React.MouseEvent, projectId: string) {
    e.stopPropagation();
    removeProject(projectId);
  }

  return (
    <aside className="w-56 bg-gray-900 border-r border-gray-700 h-full overflow-y-auto flex flex-col shrink-0">
      <div className="p-3 border-b border-gray-700">
        <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Projects</h2>
        <button
          onClick={() => setShowAdd(!showAdd)}
          className="w-full px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-gray-200 text-sm rounded transition-colors cursor-pointer"
        >
          + Add Project
        </button>
      </div>

      {showAdd && (
        <form onSubmit={handleAddProject} className="p-3 border-b border-gray-700 space-y-2">
          <input
            type="text"
            value={newPath}
            onChange={(e) => setNewPath(e.target.value)}
            placeholder="/path/to/project"
            className="w-full px-2 py-1.5 bg-gray-800 border border-gray-600 rounded text-white text-sm placeholder-gray-500 focus:outline-none focus:border-blue-500"
            autoFocus
          />
          {addError && <p className="text-xs text-red-400">{addError}</p>}
          <div className="flex gap-2">
            <button
              type="submit"
              className="flex-1 px-2 py-1 bg-blue-600 hover:bg-blue-500 text-white text-xs rounded cursor-pointer"
            >
              Add
            </button>
            <button
              type="button"
              onClick={() => { setShowAdd(false); setNewPath(''); setAddError(null); }}
              className="px-2 py-1 text-gray-400 hover:text-white text-xs cursor-pointer"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      <nav className="flex-1 overflow-y-auto">
        {projects.length === 0 && !error && (
          <p className="p-3 text-gray-500 text-sm">No projects yet</p>
        )}
        {error && (
          <p className="p-3 text-red-400 text-sm">{error}</p>
        )}
        {projects.map((project) => {
          const counts = project.taskCounts || {};
          const runningCount = (counts.running || 0) + (counts.queued || 0);
          const reviewCount = counts.awaiting_approval || 0;
          const isSelected = selectedProjectId === project.id;

          return (
            <button
              key={project.id}
              onClick={() => selectProject(project.id)}
              className={`w-full text-left px-3 py-2.5 border-b border-gray-800 group flex items-center gap-2 transition-colors cursor-pointer ${
                isSelected
                  ? 'bg-gray-700 text-white'
                  : 'text-gray-300 hover:bg-gray-800'
              }`}
            >
              <div className="flex-1 min-w-0">
                <span className="text-sm truncate block">{project.name}</span>
                <span className="text-xs text-gray-500 truncate block font-mono">{project.path}</span>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {runningCount > 0 && (
                  <span className="bg-blue-600 text-white text-xs px-1.5 py-0.5 rounded-full min-w-[18px] text-center">
                    {runningCount}
                  </span>
                )}
                {reviewCount > 0 && (
                  <span className="bg-yellow-600 text-white text-xs px-1.5 py-0.5 rounded-full min-w-[18px] text-center">
                    {reviewCount}
                  </span>
                )}
                <button
                  onClick={(e) => handleRemove(e, project.id)}
                  className="opacity-0 group-hover:opacity-100 text-gray-500 hover:text-red-400 text-xs ml-1 transition-opacity cursor-pointer"
                  title="Remove project"
                >
                  x
                </button>
              </div>
            </button>
          );
        })}
      </nav>
    </aside>
  );
}
