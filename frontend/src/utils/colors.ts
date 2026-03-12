/** Status → Tailwind border color class for task cards. */
export const statusColors: Record<string, string> = {
  todo: 'border-l-gray-500',
  queued: 'border-l-yellow-600',
  running: 'border-l-blue-500',
  awaiting_approval: 'border-l-yellow-500',
  pending: 'border-l-yellow-500',
  completed: 'border-l-green-500',
  failed: 'border-l-red-500',
  cancelled: 'border-l-gray-500',
};

/** Status → Tailwind dot color class (with animations). */
export const statusDots: Record<string, string> = {
  todo: 'bg-gray-500',
  queued: 'bg-yellow-600',
  running: 'bg-blue-500 animate-pulse',
  awaiting_approval: 'bg-yellow-500 animate-pulse',
  pending: 'bg-yellow-500',
  completed: 'bg-green-500',
  failed: 'bg-red-500',
  cancelled: 'bg-gray-500',
};
