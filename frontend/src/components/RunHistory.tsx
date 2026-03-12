import { useState, useEffect } from 'react';
import type { RunSummary, RunManifest } from '../types.ts';
import { formatDuration, formatCost } from '../utils/formatters.ts';

const PAGE_SIZE = 20;

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    completed: 'bg-green-500/20 text-green-400',
    failed: 'bg-red-500/20 text-red-400',
    running: 'bg-blue-500/20 text-blue-400',
    cancelled: 'bg-gray-500/20 text-gray-400',
  };
  const cls = colors[status] ?? 'bg-gray-500/20 text-gray-400';
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${cls}`}>
      {status}
    </span>
  );
}

function RunDetail({
  run,
  onBack,
}: {
  run: RunManifest;
  onBack: () => void;
}) {
  const stageEntries = Object.entries(run.usage.perStage);

  return (
    <div className="p-4">
      <button
        onClick={onBack}
        className="text-sm text-blue-400 hover:text-blue-300 mb-4 transition-colors"
      >
        ← Back to list
      </button>

      <h2 className="text-lg font-semibold text-white mb-2">Run {run.id.slice(0, 8)}</h2>

      <div className="mb-4">
        <p className="text-gray-300 text-sm whitespace-pre-wrap">{run.prompt}</p>
      </div>

      <div className="flex items-center gap-4 mb-4 text-sm">
        <StatusBadge status={run.status} />
        <span className="text-gray-400">
          Started: {new Date(run.startedAt).toLocaleString()}
        </span>
        {run.completedAt && (
          <span className="text-gray-400">
            Completed: {new Date(run.completedAt).toLocaleString()}
          </span>
        )}
        <span className="text-gray-400">
          Duration: {formatDuration(run.duration)}
        </span>
      </div>

      {/* Per-stage cost breakdown */}
      {stageEntries.length > 0 && (
        <div className="mb-6">
          <h3 className="text-sm font-semibold text-white mb-2">Cost Breakdown</h3>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-700">
                <th className="text-left py-1.5 pr-3 text-gray-400 font-medium">Stage</th>
                <th className="text-right py-1.5 px-2 text-gray-400 font-medium">Input Tokens</th>
                <th className="text-right py-1.5 px-2 text-gray-400 font-medium">Output Tokens</th>
                <th className="text-right py-1.5 px-2 text-gray-400 font-medium">Cache Read</th>
                <th className="text-right py-1.5 px-2 text-gray-400 font-medium">Cost</th>
              </tr>
            </thead>
            <tbody>
              {stageEntries.map(([stage, data]) => (
                <tr key={stage} className="border-b border-gray-700/50">
                  <td className="py-1.5 pr-3 text-gray-300 capitalize">{stage}</td>
                  <td className="text-right py-1.5 px-2 text-gray-400">{data.inputTokens.toLocaleString()}</td>
                  <td className="text-right py-1.5 px-2 text-gray-400">{data.outputTokens.toLocaleString()}</td>
                  <td className="text-right py-1.5 px-2 text-gray-400">{data.cacheReadTokens.toLocaleString()}</td>
                  <td className="text-right py-1.5 px-2 text-gray-300">{formatCost(data.estimatedCost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Git info */}
      {run.gitInfo && (
        <div className="mb-6">
          <h3 className="text-sm font-semibold text-white mb-2">Git Info</h3>
          <div className="text-sm space-y-1">
            <div className="text-gray-400">
              Branch: <span className="text-gray-300 font-mono">{run.gitInfo.branch}</span>
            </div>
            <div className="text-gray-400">
              Commits: <span className="text-gray-300 font-mono">{run.gitInfo.commitBefore?.slice(0, 8)}</span>
              {run.gitInfo.commitAfter && (
                <> → <span className="text-gray-300 font-mono">{run.gitInfo.commitAfter.slice(0, 8)}</span></>
              )}
            </div>
            {run.gitInfo.filesModified.length > 0 && (
              <div className="text-gray-400">
                Files modified ({run.gitInfo.filesModified.length}):
                <ul className="ml-4 mt-1">
                  {run.gitInfo.filesModified.map((f) => (
                    <li key={f} className="text-gray-300 font-mono text-xs">{f}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function RunHistory() {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedRun, setSelectedRun] = useState<RunManifest | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [page, setPage] = useState(0);

  useEffect(() => {
    fetch('/api/runs?limit=50')
      .then((res) => res.json())
      .then((data: RunSummary[]) => setRuns(data))
      .catch((err) => console.error('Failed to fetch runs:', err))
      .finally(() => setLoading(false));
  }, []);

  const totalPages = Math.max(1, Math.ceil(runs.length / PAGE_SIZE));
  const pageRuns = runs.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  async function handleSelectRun(id: string) {
    setLoadingDetail(true);
    try {
      const res = await fetch(`/api/runs/${id}`);
      const data: RunManifest = await res.json();
      setSelectedRun(data);
    } catch (err) {
      console.error('Failed to fetch run detail:', err);
    } finally {
      setLoadingDetail(false);
    }
  }

  if (selectedRun) {
    return <RunDetail run={selectedRun} onBack={() => setSelectedRun(null)} />;
  }

  if (loading) {
    return (
      <div className="p-6">
        <p className="text-gray-400">Loading...</p>
      </div>
    );
  }

  if (runs.length === 0) {
    return (
      <div className="p-6">
        <h2 className="text-lg font-semibold text-white mb-4">Run History</h2>
        <p className="text-gray-500">No runs found.</p>
      </div>
    );
  }

  return (
    <div className="p-4">
      <h2 className="text-lg font-semibold text-white mb-4">Run History</h2>

      {loadingDetail && (
        <p className="text-gray-400 text-sm mb-2">Loading run details...</p>
      )}

      <div className="space-y-1">
        {pageRuns.map((run) => (
          <div
            key={run.id}
            onClick={() => handleSelectRun(run.id)}
            className="flex items-center gap-3 px-3 py-2 rounded hover:bg-gray-700/50 cursor-pointer transition-colors"
          >
            <span className="text-gray-400 font-mono text-sm w-[5.5rem] shrink-0">
              {run.id.slice(0, 8)}
            </span>
            <span className="text-gray-300 text-sm flex-1 truncate">
              {run.prompt.length > 60 ? run.prompt.slice(0, 60) + '…' : run.prompt}
            </span>
            <StatusBadge status={run.status} />
            <span className="text-gray-500 text-sm w-16 text-right shrink-0">
              {formatDuration(run.duration)}
            </span>
            <span className="text-gray-500 text-sm w-20 text-right shrink-0">
              {formatCost(run.estimatedCost)}
            </span>
          </div>
        ))}
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between mt-4 text-sm">
        <button
          onClick={() => setPage((p) => p - 1)}
          disabled={page === 0}
          className="px-3 py-1 rounded bg-gray-700 text-gray-300 hover:bg-gray-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          Previous
        </button>
        <span className="text-gray-500">
          Page {page + 1} of {totalPages}
        </span>
        <button
          onClick={() => setPage((p) => p + 1)}
          disabled={page >= totalPages - 1}
          className="px-3 py-1 rounded bg-gray-700 text-gray-300 hover:bg-gray-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          Next
        </button>
      </div>
    </div>
  );
}
