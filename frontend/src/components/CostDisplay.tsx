import { useState } from 'react';
import { useOrchestratorStore } from '../stores/orchestratorStore.ts';
import { formatTokens } from '../utils/formatters.ts';

function formatCostCompact(n: number): string {
  return `$${n.toFixed(2)}`;
}

export function CostDisplay({ taskId, compact }: { taskId: string; compact?: boolean }) {
  const usage = useOrchestratorStore((state) => state.usage.get(taskId));
  const [expanded, setExpanded] = useState(false);

  if (!usage) return compact ? null : <span className="text-sm text-gray-500">—</span>;

  if (compact) {
    return <span className="text-xs text-green-400">{formatCostCompact(usage.estimatedCost)}</span>;
  }

  const stageEntries = Object.entries(usage.perStage);
  // Aggregate perSubtask into a synthetic "Execute" entry if not already in perStage
  if (usage.perSubtask && Object.keys(usage.perSubtask).length > 0 && !usage.perStage?.Execute) {
    let input = 0, output = 0, cache = 0, cost = 0;
    for (const u of Object.values(usage.perSubtask)) {
      input += u.inputTokens; output += u.outputTokens;
      cache += u.cacheReadTokens; cost += u.estimatedCost;
    }
    stageEntries.push(['Execute', { inputTokens: input, outputTokens: output, cacheReadTokens: cache, estimatedCost: cost }]);
  }

  return (
    <div>
      <div className="flex items-center gap-2 text-sm">
        <span className="text-green-400 font-medium">{formatCostCompact(usage.estimatedCost)}</span>
        <span className="text-gray-500">|</span>
        <span className="text-gray-300">
          {formatTokens(usage.totalInputTokens)} in / {formatTokens(usage.totalOutputTokens)} out
        </span>
        {stageEntries.length > 0 && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-xs text-gray-500 hover:text-gray-300 ml-1"
          >
            {expanded ? '▼' : '▶'}
          </button>
        )}
      </div>
      {expanded && stageEntries.length > 0 && (
        <table className="mt-2 text-xs text-gray-400 w-full">
          <thead>
            <tr className="border-b border-gray-700">
              <th className="text-left py-1 pr-3 font-medium">Stage</th>
              <th className="text-right py-1 px-2 font-medium">Cost</th>
              <th className="text-right py-1 px-2 font-medium">In</th>
              <th className="text-right py-1 px-2 font-medium">Out</th>
            </tr>
          </thead>
          <tbody>
            {stageEntries.map(([stage, data]) => (
              <tr key={stage} className="border-b border-gray-700/50">
                <td className="py-1 pr-3 text-gray-300 capitalize">{stage}</td>
                <td className="text-right py-1 px-2">{formatCostCompact(data.estimatedCost)}</td>
                <td className="text-right py-1 px-2">{formatTokens(data.inputTokens)}</td>
                <td className="text-right py-1 px-2">{formatTokens(data.outputTokens)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
