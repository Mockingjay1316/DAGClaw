import { useState } from 'react';
import { useOrchestratorStore } from '../stores/orchestratorStore.ts';
import { useWebSocket } from '../hooks/useWebSocket.ts';

interface CreateTaskFormProps {
  onClose: () => void;
}

export function CreateTaskForm({ onClose }: CreateTaskFormProps) {
  const addRootTask = useOrchestratorStore((s) => s.addRootTask);
  const selectRoot = useOrchestratorStore((s) => s.selectRoot);
  const { subscribe } = useWebSocket();

  const [prompt, setPrompt] = useState('');
  const [workDir, setWorkDir] = useState('/');
  const [pipeline, setPipeline] = useState('Plan,Execute,Verify');
  const [autoApprove, setAutoApprove] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!prompt.trim()) return;

    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: prompt.trim(),
          workDir,
          pipeline: pipeline.split(',').map((s) => s.trim()).filter(Boolean),
          autoApprove,
        }),
      });

      if (!res.ok) {
        const body = await res.text();
        throw new Error(body || `Request failed: ${res.status}`);
      }

      const task = await res.json();
      addRootTask(task);
      selectRoot(task.id);
      subscribe([task.id]);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-gray-800 rounded-lg shadow-xl w-full max-w-md p-6">
        <h2 className="text-lg font-semibold text-white mb-4">New Task</h2>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Prompt */}
          <div>
            <label htmlFor="prompt" className="block text-sm font-medium text-gray-300 mb-1">
              Prompt <span className="text-red-400">*</span>
            </label>
            <textarea
              id="prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              required
              rows={4}
              className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white text-sm placeholder-gray-400 focus:outline-none focus:border-blue-500 resize-y"
              placeholder="Describe the task..."
            />
          </div>

          {/* Work Directory */}
          <div>
            <label htmlFor="workDir" className="block text-sm font-medium text-gray-300 mb-1">
              Working Directory
            </label>
            <input
              id="workDir"
              type="text"
              value={workDir}
              onChange={(e) => setWorkDir(e.target.value)}
              className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white text-sm placeholder-gray-400 focus:outline-none focus:border-blue-500"
            />
          </div>

          {/* Pipeline */}
          <div>
            <label htmlFor="pipeline" className="block text-sm font-medium text-gray-300 mb-1">
              Pipeline
            </label>
            <input
              id="pipeline"
              type="text"
              value={pipeline}
              onChange={(e) => setPipeline(e.target.value)}
              className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white text-sm placeholder-gray-400 focus:outline-none focus:border-blue-500"
              placeholder="Plan,Execute,Verify"
            />
          </div>

          {/* Auto Approve */}
          <div className="flex items-center gap-2">
            <input
              id="autoApprove"
              type="checkbox"
              checked={autoApprove}
              onChange={(e) => setAutoApprove(e.target.checked)}
              className="w-4 h-4 rounded bg-gray-700 border-gray-600 text-blue-500 focus:ring-blue-500"
            />
            <label htmlFor="autoApprove" className="text-sm text-gray-300">
              Auto-approve plan
            </label>
          </div>

          {/* Error */}
          {error && (
            <p className="text-sm text-red-400 bg-red-900/30 rounded px-3 py-2">{error}</p>
          )}

          {/* Actions */}
          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm text-gray-300 hover:text-white transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || !prompt.trim()}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium rounded transition-colors cursor-pointer"
            >
              {submitting ? 'Creating...' : 'Create Task'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
