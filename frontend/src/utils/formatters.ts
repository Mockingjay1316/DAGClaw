/** Format elapsed time between two ISO date strings. */
export function formatElapsed(startedAt?: string, finishedAt?: string): string | null {
  if (!startedAt || !finishedAt) return null;
  const ms = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
  if (ms < 0) return null;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainSec = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainSec}s`;
  const hours = Math.floor(minutes / 60);
  const remainMin = minutes % 60;
  return `${hours}h ${remainMin}m`;
}

/** Format a duration in seconds to a human-readable string. */
export function formatDuration(duration: number | null): string {
  if (duration == null) return '—';
  if (duration < 60) return `${Math.round(duration)}s`;
  const mins = Math.floor(duration / 60);
  const secs = Math.round(duration % 60);
  return `${mins}m ${secs}s`;
}

/** Format a cost value as a dollar string. */
export function formatCost(n: number): string {
  if (n === 0) return '—';
  return `$${n.toFixed(n < 1 ? 4 : 2)}`;
}

/** Format a token count with k suffix. */
export function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/** Truncate text to a max length with ellipsis. */
export function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + '\u2026' : text;
}
