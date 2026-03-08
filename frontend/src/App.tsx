import { Sidebar } from './components/Sidebar.tsx';
import { TaskTreeView } from './components/TaskTreeView.tsx';
import { DetailPanel } from './components/DetailPanel.tsx';
import { useWebSocket } from './hooks/useWebSocket.ts';

function App() {
  // Establish WebSocket connection on app mount
  const { connected } = useWebSocket();

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Left: Sidebar (fixed width) */}
      <Sidebar />

      {/* Center: Task tree view */}
      <div className="flex-1 min-w-[300px] border-l border-gray-800 overflow-y-auto">
        <TaskTreeView />
      </div>

      {/* Right: Detail panel */}
      <div className="flex-[2] border-l border-gray-800 overflow-hidden">
        <DetailPanel />
      </div>

      {/* Connection status indicator */}
      {!connected && (
        <div className="fixed bottom-4 right-4 bg-red-900/80 text-red-200 text-xs px-3 py-1.5 rounded-full backdrop-blur-sm">
          Disconnected — reconnecting…
        </div>
      )}
    </div>
  );
}

export default App;
