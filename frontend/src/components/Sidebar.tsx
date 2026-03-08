import { useEffect, useState } from 'react';
import { useOrchestratorStore } from '../stores/orchestratorStore.ts';
import type { TaskStatus } from '../types.ts';
import { CreateTaskForm } from './CreateTaskForm.tsx';

const statusColor: Record<TaskStatus, string> = {
  completed: 'bg-green-500',
  running: 'bg-blue-500',
  pending: 'bg-yellow-500',
  awaiting_approval: 'bg-yellow-500',
  failed: 'bg-red-500',
  cancelled: 'bg-gray-500',
  skipped: 'bg-gray-500',
};

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + '\u2026' : text;
}

export function Sidebar() {
  const rootTasks = useOrchestratorStore((s) => s.rootTasks);
  const selectedRootId = useOrchestratorStore((s) => s.selectedRootId);
  const setRootTasks = useOrchestratorStore((s) => s.setRootTasks);
  const selectRoot = useOrchestratorStore((s) => s.selectRoot);

  const [showCreate, setShowCreate] = useState(false);

  useEffect(() => {
    fetch('/api/tasks')
      .then((res) => {
        if (!res.ok) throw new Error(`Failed to fetch tasks: ${res.status}`);
        return res.json();
      })
      .then((tasks) => setRootTasks(tasks))
      .catch((err) => console.error('Failed to load tasks:', err));
  }, [setRootTasks]);

  return (
    <>
      <aside className="w-64 bg-gray-900 border-r border-gray-700 h-full overflow-y-auto flex flex-col">
        <div className="p-3 border-b border-gray-700">
          <button
            onClick={() => setShowCreate(true)}
            className="w-full px-3 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded transition-colors cursor-pointer"
          >
            + New Task
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto">
          {rootTasks.length === 0 && (
            <p className="p-3 text-gray-500 text-sm">No tasks yet</p>
          )}
          {rootTasks.map((task) => (
            <button
              key={task.id}
              onClick={() => selectRoot(task.id)}
              className={`w-full text-left px-3 py-2.5 border-b border-gray-800 flex items-center gap-2 transition-colors cursor-pointer ${
                selectedRootId === task.id
                  ? 'bg-gray-700 text-white'
                  : 'text-gray-300 hover:bg-gray-800'
              }`}
            >
              <span
                className={`w-2 h-2 rounded-full shrink-0 ${statusColor[task.status] ?? 'bg-gray-500'}`}
                title={task.status}
              />
              <span className="text-sm truncate">
                {truncate(task.prompt, 50)}
              </span>
            </button>
          ))}
        </nav>
      </aside>

      {showCreate && <CreateTaskForm onClose={() => setShowCreate(false)} />}
    </>
  );
}
