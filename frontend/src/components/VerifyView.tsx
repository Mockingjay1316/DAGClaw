import { useOrchestratorStore } from '../stores/orchestratorStore.ts';

interface VerifyViewProps {
  taskId: string;
}

export function VerifyView({ taskId }: VerifyViewProps) {
  const verification = useOrchestratorStore((state) => state.verifications.get(taskId));

  if (!verification) {
    return (
      <div className="flex items-center gap-3 p-6 text-gray-400">
        <svg
          className="animate-spin h-5 w-5 text-blue-400"
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
        >
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path
            className="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
          />
        </svg>
        Running verification...
      </div>
    );
  }

  const { overallPass, subtaskResults, integrationResult } = verification;

  return (
    <div className="flex flex-col gap-4 p-4 overflow-y-auto">
      {/* Overall result */}
      <div className="flex items-center gap-3 p-4 rounded-lg bg-gray-800">
        <span className={`text-4xl ${overallPass ? 'text-green-400' : 'text-red-400'}`}>
          {overallPass ? '\u2713' : '\u2717'}
        </span>
        <div>
          <div className="text-lg font-semibold text-gray-100">
            Verification {overallPass ? 'Passed' : 'Failed'}
          </div>
          <div className="text-sm text-gray-400">
            {subtaskResults.filter((r) => r.pass).length}/{subtaskResults.length} subtasks passed
          </div>
        </div>
      </div>

      {/* Subtask results */}
      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium text-gray-300 uppercase tracking-wide">
          Subtask Results
        </h3>
        {subtaskResults.map((result) => (
          <div
            key={result.subtaskIndex}
            className="flex items-start gap-3 p-3 rounded bg-gray-800 border border-gray-700"
          >
            <span
              className={`px-2 py-0.5 rounded text-xs font-medium text-white ${
                result.pass ? 'bg-green-600' : 'bg-red-600'
              }`}
            >
              {result.pass ? 'PASS' : 'FAIL'}
            </span>
            <div className="flex-1 min-w-0">
              <div className="text-sm text-gray-200">
                <span className="font-mono text-gray-400">#{result.subtaskIndex}</span>{' '}
                {result.summary}
              </div>
              {result.retryRecommended && (
                <span className="inline-block mt-1 px-2 py-0.5 rounded text-xs bg-yellow-600 text-white">
                  Retry recommended
                </span>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Integration result */}
      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium text-gray-300 uppercase tracking-wide">
          Integration Result
        </h3>
        <div className="p-3 rounded bg-gray-800 border border-gray-700">
          <div className="flex items-center gap-2 mb-2">
            <span
              className={`px-2 py-0.5 rounded text-xs font-medium text-white ${
                integrationResult.pass ? 'bg-green-600' : 'bg-red-600'
              }`}
            >
              {integrationResult.pass ? 'PASS' : 'FAIL'}
            </span>
            <span className="text-sm text-gray-200">{integrationResult.summary}</span>
          </div>
          {integrationResult.issues.length > 0 && (
            <ul className="list-disc list-inside text-sm text-gray-400 space-y-1">
              {integrationResult.issues.map((issue, i) => (
                <li key={i}>{issue}</li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
