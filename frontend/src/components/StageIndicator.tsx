interface StageIndicatorProps {
  currentStage: string;
  status: string;
  pipeline?: string[];
}

const DEFAULT_PIPELINE = ['Plan', 'Execute', 'Verify'];

function getSegmentColor(
  stage: string,
  currentStage: string,
  status: string,
  pipeline: string[]
): string {
  const stageIdx = pipeline.indexOf(stage);
  const currentIdx = pipeline.indexOf(currentStage);

  if (stageIdx < 0 || currentIdx < 0) return 'bg-gray-600';

  if (stageIdx < currentIdx) {
    // Past stages are completed
    return 'bg-green-500';
  }

  if (stageIdx === currentIdx) {
    // Current stage — color by status
    switch (status) {
      case 'running':
        return 'bg-blue-500 animate-pulse';
      case 'completed':
        return 'bg-green-500';
      case 'failed':
        return 'bg-red-500';
      case 'awaiting_approval':
        return 'bg-yellow-500';
      default:
        return 'bg-gray-600';
    }
  }

  // Future stages are pending
  return 'bg-gray-600';
}

export function StageIndicator({
  currentStage,
  status,
  pipeline = DEFAULT_PIPELINE,
}: StageIndicatorProps) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-row gap-1">
        {pipeline.map((stage) => (
          <div
            key={stage}
            className={`h-2 flex-1 rounded ${getSegmentColor(stage, currentStage, status, pipeline)}`}
            title={stage}
          />
        ))}
      </div>
      <span className="text-xs text-gray-400">{currentStage}</span>
    </div>
  );
}
