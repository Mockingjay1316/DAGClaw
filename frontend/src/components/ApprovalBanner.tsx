import { useState } from 'react';
import { approveTask, rejectTask } from '../api/tasks.ts';

interface ApprovalBannerProps {
  taskId: string;
  message: string;
}

export function ApprovalBanner({ taskId, message }: ApprovalBannerProps) {
  const [showFeedback, setShowFeedback] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleApprove() {
    setSubmitting(true);
    try {
      await approveTask(taskId);
    } catch {
      // Best-effort
    } finally {
      setSubmitting(false);
    }
  }

  async function handleReject() {
    if (!showFeedback) {
      setShowFeedback(true);
      return;
    }
    setSubmitting(true);
    try {
      await rejectTask(taskId, feedback || undefined);
    } catch {
      // Best-effort
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed bottom-0 left-0 right-0 z-50 bg-yellow-900/90 backdrop-blur animate-slide-up">
      <div className="max-w-4xl mx-auto px-4 py-3">
        <div className="flex items-center justify-between gap-4">
          <p className="text-yellow-100 text-sm flex-1">{message}</p>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={handleApprove}
              disabled={submitting}
              className="px-4 py-1.5 rounded bg-green-600 hover:bg-green-500 text-white text-sm font-medium disabled:opacity-50 transition-colors"
            >
              Approve
            </button>
            <button
              onClick={handleReject}
              disabled={submitting}
              className="px-4 py-1.5 rounded bg-red-600 hover:bg-red-500 text-white text-sm font-medium disabled:opacity-50 transition-colors"
            >
              Reject
            </button>
          </div>
        </div>

        {showFeedback && (
          <div className="mt-2">
            <textarea
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              placeholder="Optional feedback for rejection..."
              rows={2}
              className="w-full bg-gray-800 text-white text-sm rounded p-2 border border-yellow-700 placeholder-gray-500 focus:outline-none focus:border-yellow-500"
            />
            <div className="flex justify-end mt-1">
              <button
                onClick={() => setShowFeedback(false)}
                className="text-xs text-gray-400 hover:text-gray-200 mr-2"
              >
                Cancel
              </button>
              <button
                onClick={handleReject}
                disabled={submitting}
                className="text-xs px-3 py-1 rounded bg-red-600 hover:bg-red-500 text-white disabled:opacity-50 transition-colors"
              >
                Submit Rejection
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
