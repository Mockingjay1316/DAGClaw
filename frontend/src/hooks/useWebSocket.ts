import { useEffect, useSyncExternalStore } from 'react';
import type { WsMessage, WsClientMessage } from '../types.ts';
import { useOrchestratorStore } from '../stores/orchestratorStore.ts';

// --- Subtask output callback registry ---

type SubtaskOutputCallback = (taskId: string, subtaskIndex: number, data: string) => void;

const subtaskOutputListeners = new Set<SubtaskOutputCallback>();

/**
 * Register a listener for subtask_output messages.
 * Returns an unsubscribe function.
 * This bypasses Zustand — output goes directly to xterm.js refs.
 */
export function onSubtaskOutput(
  callback: SubtaskOutputCallback
): () => void {
  subtaskOutputListeners.add(callback);
  return () => {
    subtaskOutputListeners.delete(callback);
  };
}

// --- Singleton WebSocket connection ---

let ws: WebSocket | null = null;
let connected = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelay = 1000;
const MAX_RECONNECT_DELAY = 30000;
const activeSubscriptions = new Set<string>();
const activeProjectSubscriptions = new Set<string>();

// External store for `connected` state (useSyncExternalStore pattern)
const connectedListeners = new Set<() => void>();

function getConnected() {
  return connected;
}

function setConnected(value: boolean) {
  if (connected !== value) {
    connected = value;
    connectedListeners.forEach((l) => l());
  }
}

function subscribeConnected(listener: () => void) {
  connectedListeners.add(listener);
  return () => {
    connectedListeners.delete(listener);
  };
}

function getWsUrl(): string {
  if (typeof window !== 'undefined' && window.location.hostname !== 'localhost') {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${window.location.host}/ws`;
  }
  return 'ws://localhost:3001';
}

function send(msg: WsClientMessage) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  const url = getWsUrl();
  ws = new WebSocket(url);

  ws.onopen = () => {
    setConnected(true);
    reconnectDelay = 1000; // reset backoff on successful connection

    // Send auth if API key is available
    const apiKey =
      (typeof window !== 'undefined' && (window as unknown as Record<string, unknown>).CLAW_API_KEY as string | undefined) ||
      undefined;
    if (apiKey) {
      ws!.send(JSON.stringify({ type: 'auth', token: apiKey }));
    }

    // Re-subscribe to all active subscriptions after reconnect
    if (activeSubscriptions.size > 0) {
      send({ type: 'subscribe', nodeIds: [...activeSubscriptions] });
    }

    // Re-subscribe to project subscriptions after reconnect
    for (const projectId of activeProjectSubscriptions) {
      send({ type: 'subscribe_project', projectId });
    }
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data) as WsMessage;

      // subtask_output goes directly to listeners, bypasses Zustand
      if (msg.type === 'subtask_output') {
        subtaskOutputListeners.forEach((cb) => cb(msg.taskId, msg.index, msg.data));
        return;
      }

      // All other messages go through the Zustand store
      useOrchestratorStore.getState().handleWsMessage(msg);
    } catch {
      // Ignore malformed messages
    }
  };

  ws.onclose = () => {
    setConnected(false);
    ws = null;
    scheduleReconnect();
  };

  ws.onerror = () => {
    // onclose will fire after onerror, so reconnection is handled there
    ws?.close();
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
    connect();
  }, reconnectDelay);
}

function disconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    ws.onclose = null; // prevent reconnect on intentional close
    ws.close();
    ws = null;
  }
  setConnected(false);
}

// --- Exported action functions ---

function subscribe(nodeIds: string[]) {
  for (const id of nodeIds) activeSubscriptions.add(id);
  send({ type: 'subscribe', nodeIds });
}

function unsubscribe(nodeIds: string[]) {
  for (const id of nodeIds) activeSubscriptions.delete(id);
  send({ type: 'unsubscribe', nodeIds });
}

function subscribeProject(projectId: string) {
  activeProjectSubscriptions.add(projectId);
  send({ type: 'subscribe_project', projectId });
}

function unsubscribeProject(projectId: string) {
  activeProjectSubscriptions.delete(projectId);
  send({ type: 'unsubscribe_project', projectId });
}

function approvePlan(taskId: string) {
  send({ type: 'approve_plan', taskId });
}

function rejectPlan(taskId: string, feedback?: string) {
  send({ type: 'reject_plan', taskId, feedback });
}

function cancelTask(taskId: string) {
  send({ type: 'cancel', taskId });
}

function executeTask(taskId: string) {
  send({ type: 'execute_task', taskId });
}

// --- React hook ---

export function useWebSocket() {
  const isConnected = useSyncExternalStore(subscribeConnected, getConnected, getConnected);

  useEffect(() => {
    connect();
    return () => {
      // Don't disconnect on unmount — singleton stays alive.
    };
  }, []);

  return {
    subscribe,
    unsubscribe,
    subscribeProject,
    unsubscribeProject,
    approvePlan,
    rejectPlan,
    cancelTask,
    executeTask,
    connected: isConnected,
  };
}

export { connect, disconnect };
