import { useState } from 'react';
import { useProjectStore } from '../stores/projectStore.ts';
import { useOrchestratorStore } from '../stores/orchestratorStore.ts';
import { useWebSocket } from '../hooks/useWebSocket.ts';

export function TaskCreationBar() {
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId);
  const addRootTask = useOrchestratorStore((s) => s.addRootTask);
  const selectRoot = useOrchestratorStore((s) => s.selectRoot);
  const { subscribe } = useWebSocket();

  const [prompt, setPrompt] = useState('');
  const [showOptions, setShowOptions] = useState(false);
  const [pipeline, setPipeline] = useState('Plan,Execute,Verify');
  const [permissionMode, setPermissionMode] = useState<'interactive' | 'auto-approve' | 'yolo'>('interactive');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(execute: boolean) {
    if (!prompt.trim() || !selectedProjectId) return;
    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch(`/api/projects/${selectedProjectId}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: prompt.trim(),
          pipeline: pipeline.split(',').map(s => s.trim()).filter(Boolean),
          permissionMode,
          execute,
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: `Request failed: ${res.status}` }));
        throw new Error(body.error || `Request failed: ${res.status}`);
      }

      const task = await res.json();
      addRootTask(task);
      if (execute) {
        selectRoot(task.id);
        subscribe([task.id]);
      }
      setPrompt('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setSubmitting(false);
    }
  }

  if (!selectedProjectId) return null;

  return (
    <div className="border-b border-gray-700 bg-gray-800">
      <div className="p-3">
        <div className="flex gap-2">
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Describe the task..."
            rows={1}
            className="flex-1 px-3 py-2 bg-gray-800 border border-gray-600 rounded text-white text-sm placeholder-gray-500 focus:outline-none focus:border-blue-500 resize-none"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                submit(true);
              }
            }}
          />
          <button
            onClick={() => submit(false)}
            disabled={submitting || !prompt.trim()}
            className="px-3 py-2 bg-gray-600 hover:bg-gray-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm rounded transition-colors cursor-pointer whitespace-nowrap"
            title="Save as TODO"
          >
            TODO
          </button>
          <button
            onClick={() => submit(true)}
            disabled={submitting || !prompt.trim()}
            className="px-3 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium rounded transition-colors cursor-pointer whitespace-nowrap"
            title="Execute immediately (Ctrl+Enter)"
          >
            Execute
          </button>
          <button
            onClick={() => setShowOptions(!showOptions)}
            className="px-2 py-2 text-gray-400 hover:text-white transition-colors cursor-pointer"
            title="Options"
          >
            {showOptions ? '\u25B2' : '\u25BC'}
          </button>
        </div>

        {showOptions && (
          <div className="mt-2 flex gap-4 text-sm">
            <div className="flex items-center gap-2">
              <label className="text-gray-400">Pipeline:</label>
              <input
                type="text"
                value={pipeline}
                onChange={(e) => setPipeline(e.target.value)}
                className="px-2 py-1 bg-gray-800 border border-gray-600 rounded text-white text-xs w-48 focus:outline-none focus:border-blue-500"
              />
            </div>
            <div className="flex items-center gap-2">
              <label className="text-gray-400">Mode:</label>
              <select
                value={permissionMode}
                onChange={(e) => setPermissionMode(e.target.value as 'interactive' | 'auto-approve' | 'yolo')}
                className="px-2 py-1 bg-gray-800 border border-gray-600 rounded text-white text-xs focus:outline-none focus:border-blue-500"
              >
                <option value="interactive">Interactive</option>
                <option value="auto-approve">Auto-approve</option>
                <option value="yolo">YOLO</option>
              </select>
            </div>
          </div>
        )}

        {error && (
          <p className="mt-2 text-sm text-red-400 bg-red-900/30 rounded px-3 py-1.5">{error}</p>
        )}
      </div>
    </div>
  );
}
