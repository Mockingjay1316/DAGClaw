export async function approveTask(taskId: string): Promise<void> {
  const res = await fetch(`/api/tasks/${taskId}/approve`, { method: 'POST' });
  if (!res.ok) throw new Error(`Approve failed: ${res.status}`);
}

export async function rejectTask(taskId: string, feedback?: string): Promise<void> {
  const res = await fetch(`/api/tasks/${taskId}/reject`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ feedback }),
  });
  if (!res.ok) throw new Error(`Reject failed: ${res.status}`);
}

export async function cancelTask(taskId: string): Promise<void> {
  const res = await fetch(`/api/tasks/${taskId}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`Cancel failed: ${res.status}`);
}

export async function retryTask(taskId: string): Promise<{ id: string }> {
  const res = await fetch(`/api/tasks/${taskId}/retry`, { method: 'POST' });
  if (!res.ok) throw new Error(`Retry failed: ${res.status}`);
  return res.json();
}

export async function executeTask(taskId: string): Promise<void> {
  const res = await fetch(`/api/tasks/${taskId}/execute`, { method: 'POST' });
  if (!res.ok) throw new Error(`Execute failed: ${res.status}`);
}

export async function createTask(projectId: string, opts: {
  prompt: string;
  workDir: string;
  pipeline?: string[];
  permissionMode?: string;
}): Promise<{ id: string }> {
  const res = await fetch('/api/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId, ...opts }),
  });
  if (!res.ok) throw new Error(`Create task failed: ${res.status}`);
  return res.json();
}

export async function fetchUsage(taskId: string): Promise<{ usage: unknown } | null> {
  const res = await fetch(`/api/tasks/${taskId}/usage`);
  if (!res.ok) return null;
  return res.json();
}
