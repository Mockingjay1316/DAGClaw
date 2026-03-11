import { useEffect } from 'react';
import { ProjectSidebar } from './components/ProjectSidebar.tsx';
import { CenterPanel } from './components/CenterPanel.tsx';
import { DetailPanel } from './components/DetailPanel.tsx';
import { useWebSocket } from './hooks/useWebSocket.ts';
import { useOrchestratorStore } from './stores/orchestratorStore.ts';
import { useProjectStore } from './stores/projectStore.ts';

function App() {
  // Establish WebSocket connection on app mount
  const { connected } = useWebSocket();

  const selectedNodeId = useOrchestratorStore((s) => s.selectedNodeId);
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId);
  const setRootTasks = useOrchestratorStore((s) => s.setRootTasks);

  // Fetch tasks for selected project
  useEffect(() => {
    if (!selectedProjectId) return;
    fetch(`/api/projects/${selectedProjectId}/tasks`)
      .then((res) => {
        if (!res.ok) throw new Error(`Failed to fetch tasks: ${res.status}`);
        return res.json();
      })
      .then((tasks) => {
        setRootTasks(tasks);
      })
      .catch((err) => console.error('Failed to load tasks:', err));
  }, [selectedProjectId, setRootTasks]);

  return (
    <div className="flex h-screen overflow-hidden bg-gray-900 text-gray-100">
      {/* Left: Project sidebar */}
      <ProjectSidebar />

      {/* Center: Task creation + Kanban board */}
      <div className={`flex-1 flex border-l border-gray-800 overflow-hidden ${
        selectedNodeId ? '' : ''
      }`}>
        <CenterPanel />
      </div>

      {/* Right: Detail panel (slides in when a task is selected) */}
      {selectedNodeId && (
        <div className="w-[40%] min-w-[400px] border-l border-gray-800 overflow-hidden">
          <DetailPanel />
        </div>
      )}

      {/* Connection status indicator */}
      {!connected && (
        <div className="fixed bottom-4 right-4 bg-red-900/80 text-red-200 text-xs px-3 py-1.5 rounded-full backdrop-blur-sm">
          Disconnected — reconnecting...
        </div>
      )}
    </div>
  );
}

export default App;
