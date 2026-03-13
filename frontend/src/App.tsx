import { useEffect, useState, useCallback, useRef } from 'react';
import { ProjectSidebar } from './components/ProjectSidebar.tsx';
import { CenterPanel } from './components/CenterPanel.tsx';
import { DetailPanel } from './components/DetailPanel.tsx';
import { useWebSocket } from './hooks/useWebSocket.ts';
import { useOrchestratorStore } from './stores/orchestratorStore.ts';
import { useProjectStore } from './stores/projectStore.ts';

const DEFAULT_PANEL_WIDTH = 400;
const MIN_PANEL_WIDTH = 300;
const MAX_PANEL_RATIO = 0.6; // 60% of viewport

function App() {
  // Establish WebSocket connection on app mount
  const { connected } = useWebSocket();

  const selectedNodeId = useOrchestratorStore((s) => s.selectedNodeId);
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId);
  const setRootTasks = useOrchestratorStore((s) => s.setRootTasks);

  // Resizable detail panel state
  const [panelWidth, setPanelWidth] = useState(DEFAULT_PANEL_WIDTH);
  const isDragging = useRef(false);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!isDragging.current) return;
    const newWidth = window.innerWidth - e.clientX;
    const maxWidth = window.innerWidth * MAX_PANEL_RATIO;
    setPanelWidth(Math.max(MIN_PANEL_WIDTH, Math.min(maxWidth, newWidth)));
  }, []);

  const handleMouseUp = useCallback(() => {
    isDragging.current = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }, []);

  useEffect(() => {
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [handleMouseMove, handleMouseUp]);

  function handleDragStart(e: React.MouseEvent) {
    e.preventDefault();
    isDragging.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }

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
        <div
          className="relative border-l border-gray-800 overflow-hidden flex-shrink-0"
          style={{ width: panelWidth }}
        >
          {/* Drag handle */}
          <div
            onMouseDown={handleDragStart}
            className="absolute left-0 top-0 bottom-0 w-1.5 cursor-col-resize z-10 hover:bg-gray-600 active:bg-gray-500 transition-colors bg-transparent"
          />
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
