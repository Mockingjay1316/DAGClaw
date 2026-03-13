import { useState, useRef, useEffect } from 'react';
import { useProjectStore } from '../stores/projectStore.ts';
import { useOrchestratorStore } from '../stores/orchestratorStore.ts';

const MODEL_OPTIONS = [
  { label: 'Default', value: '' },
  { label: 'Sonnet', value: 'sonnet' },
  { label: 'Opus', value: 'opus' },
  { label: 'Haiku', value: 'haiku' },
  { label: 'Sonnet 1M', value: 'sonnet[1m]' },
  { label: 'Opus Plan', value: 'opusplan' },
];

interface TaskCreationBarProps {
  style?: React.CSSProperties;
  className?: string;
}

export function TaskCreationBar({ style, className }: TaskCreationBarProps) {
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId);
  const addRootTask = useOrchestratorStore((s) => s.addRootTask);
  const selectRoot = useOrchestratorStore((s) => s.selectRoot);

  const [prompt, setPrompt] = useState('');
  const [pipeline, setPipeline] = useState('Plan,Execute,Verify');
  const [permissionMode, setPermissionMode] = useState<'interactive' | 'auto-approve' | 'yolo'>('interactive');
  const [model, setModel] = useState<string>('');
  const [dagModel, setDagModel] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-grow textarea to fit content
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = textarea.scrollHeight + 'px';
  }, [prompt]);

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
          model: model || undefined,
          dagModel: dagModel || undefined,
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
    <div
      className={`flex flex-row ${className ?? ''}`}
      style={style}
    >
      {/* Left side — prompt + error + buttons */}
      <div className="flex-1 p-3 flex flex-col gap-2 min-w-0">
        <textarea
          ref={textareaRef}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Describe the task..."
          rows={3}
          className="w-full flex-1 px-3 py-2 bg-gray-800 border border-gray-600 rounded text-white text-sm placeholder-gray-500 focus:outline-none focus:border-blue-500 resize-y min-h-[72px]"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              submit(true);
            }
          }}
        />

        {error && (
          <p className="text-sm text-red-400 bg-red-900/30 rounded px-3 py-1.5 flex-shrink-0">{error}</p>
        )}

        <div className="flex items-center justify-end gap-2 flex-shrink-0">
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
        </div>
      </div>

      {/* Right side — settings drawer */}
      <div className="border-l border-gray-700 p-3 flex flex-col gap-3 min-w-[180px] w-[200px] flex-shrink-0">
        <div className="text-xs text-gray-400 font-medium uppercase tracking-wide">Task Config</div>

        <div className="flex flex-col gap-1">
          <label className="text-xs text-gray-400">Pipeline</label>
          <input
            type="text"
            value={pipeline}
            onChange={(e) => setPipeline(e.target.value)}
            className="px-2 py-1 bg-gray-800 border border-gray-600 rounded text-white text-xs w-full focus:outline-none focus:border-blue-500"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs text-gray-400">Mode</label>
          <select
            value={permissionMode}
            onChange={(e) => setPermissionMode(e.target.value as 'interactive' | 'auto-approve' | 'yolo')}
            className="px-2 py-1 bg-gray-800 border border-gray-600 rounded text-white text-xs w-full focus:outline-none focus:border-blue-500"
          >
            <option value="interactive">Interactive</option>
            <option value="auto-approve">Auto-approve</option>
            <option value="yolo">YOLO</option>
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs text-gray-400">Model</label>
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="px-2 py-1 bg-gray-800 border border-gray-600 rounded text-white text-xs w-full focus:outline-none focus:border-blue-500"
          >
            {MODEL_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs text-gray-400">DAG Model</label>
          <select
            value={dagModel}
            onChange={(e) => setDagModel(e.target.value)}
            className="px-2 py-1 bg-gray-800 border border-gray-600 rounded text-white text-xs w-full focus:outline-none focus:border-blue-500"
          >
            {MODEL_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>
      </div>
    </div>
  );
}
