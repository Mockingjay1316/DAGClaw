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

  // Task-level terminal states: all stages done
  if (status === 'completed') return 'bg-green-500';
  if (status === 'failed') {
    if (currentIdx < 0) return 'bg-red-500/50';
    if (stageIdx < currentIdx) return 'bg-green-500';
    if (stageIdx === currentIdx) return 'bg-red-500';
    return 'bg-gray-600';
  }

  if (stageIdx < 0 || currentIdx < 0) return 'bg-gray-600';

  if (stageIdx < currentIdx) {
    return 'bg-green-500';
  }

  if (stageIdx === currentIdx) {
    switch (status) {
      case 'running':
        return 'bg-blue-500 animate-pulse';
      case 'awaiting_approval':
        return 'bg-yellow-500 animate-pulse';
      default:
        return 'bg-gray-600';
    }
  }

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
      <span className="text-xs text-gray-400">
        {status === 'completed' ? 'Completed' : status === 'failed' ? 'Failed' : currentStage}
      </span>
    </div>
  );
}
