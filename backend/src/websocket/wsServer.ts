import { WebSocketServer, WebSocket } from 'ws';
import http from 'node:http';
import crypto from 'node:crypto';
import { MessageBuffer } from './messageBuffer.ts';
import { SubscriptionManager } from './subscriptionManager.ts';
import { timingSafeCompare } from '../middleware/auth.ts';

/** Forward-declared TaskStore reference to avoid circular deps. */
export interface TaskStoreRef {
  approveTask(id: string): void;
  rejectTask(id: string, feedback?: string): void;
  cancelTask(id: string): void;
  executeTask(id: string): { error?: string; status?: number };
  getTasksByProject(projectId: string): unknown[];
  toSummary(task: unknown): Record<string, unknown>;
}

/**
 * WebSocket server that manages client connections, subscriptions,
 * and message broadcasting for real-time task updates.
 */
export class WsServer {
  private wss: WebSocketServer;
  private subscriptions = new SubscriptionManager();
  private projectSubscriptions = new SubscriptionManager();
  private buffers = new Map<string, MessageBuffer>();
  private clients = new Map<string, WebSocket>();
  private taskStore: TaskStoreRef | null = null;

  constructor(server: http.Server) {
    this.wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });

    this.wss.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
      // Fix #5b: Max connections
      const MAX_WS_CLIENTS = parseInt(process.env.CLAW_MAX_WS_CLIENTS || '100', 10);
      if (this.clients.size >= MAX_WS_CLIENTS) {
        ws.close(1008, 'Server at capacity');
        return;
      }

      // WS authentication via first message
      const apiKey = process.env.CLAW_API_KEY;
      if (apiKey) {
        const authTimer = setTimeout(() => {
          ws.close(4001, 'Auth timeout');
        }, 5000);

        ws.once('message', (data: Buffer | string) => {
          clearTimeout(authTimer);
          try {
            const msg = JSON.parse(typeof data === 'string' ? data : data.toString());
            if (msg.type === 'auth' && typeof msg.token === 'string' && timingSafeCompare(msg.token, apiKey)) {
              this.registerClient(ws);
            } else {
              ws.close(4001, 'Unauthorized');
            }
          } catch {
            ws.close(4001, 'Unauthorized');
          }
        });
      } else {
        this.registerClient(ws);
      }
    });
  }

  private registerClient(ws: WebSocket): void {
    const clientId = crypto.randomUUID();
    this.clients.set(clientId, ws);

    ws.on('message', (data: Buffer | string) => {
      try {
        const msg = JSON.parse(typeof data === 'string' ? data : data.toString());
        this.handleMessage(clientId, ws, msg);
      } catch {
        // Ignore malformed messages
      }
    });

    ws.on('close', () => {
      this.cleanup(clientId);
    });

    ws.on('error', () => {
      this.cleanup(clientId);
    });
  }

  /** Sets the task store reference for handling approve/reject/cancel. */
  setTaskStore(store: TaskStoreRef): void {
    this.taskStore = store;
  }

  /** Broadcast a message to all clients subscribed to a specific node. */
  broadcast(nodeId: string, message: Record<string, unknown>): void {
    const buffer = this.getBuffer(nodeId);
    buffer.push(message);

    const subscribers = this.subscriptions.getSubscribers(nodeId);
    const payload = JSON.stringify(message);
    for (const clientId of subscribers) {
      const ws = this.clients.get(clientId);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      }
    }
  }

  /** Broadcast a message to ALL connected clients (for global events). */
  broadcastAll(message: Record<string, unknown>): void {
    const payload = JSON.stringify(message);
    for (const [clientId, ws] of this.clients.entries()) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      }
    }
  }

  /** Broadcast to all clients subscribed to a specific project. */
  broadcastProject(projectId: string, message: Record<string, unknown>): void {
    const subscribers = this.projectSubscriptions.getSubscribers(projectId);
    const payload = JSON.stringify(message);
    for (const clientId of subscribers) {
      const ws = this.clients.get(clientId);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      }
    }
  }

  /** Returns the message buffer for a given node, creating one if needed. */
  getBuffer(nodeId: string): MessageBuffer {
    let buffer = this.buffers.get(nodeId);
    if (!buffer) {
      // Fix #5d: Evict oldest buffer if at capacity
      if (this.buffers.size >= 10_000) {
        const oldest = this.buffers.keys().next().value;
        if (oldest) this.buffers.delete(oldest);
      }
      buffer = new MessageBuffer();
      this.buffers.set(nodeId, buffer);
    }
    return buffer;
  }

  private handleMessage(clientId: string, ws: WebSocket, msg: Record<string, unknown>): void {
    switch (msg.type) {
      case 'subscribe': {
        if (!Array.isArray(msg.nodeIds)) {
          console.warn('[WsServer] Invalid message: nodeIds must be an array, got:', typeof msg.nodeIds);
          return;
        }
        const nodeIds = msg.nodeIds as string[];
        if (nodeIds.length > 100) {
          console.warn('[WsServer] Subscription array too large:', nodeIds.length);
          return;
        }
        this.subscriptions.subscribe(clientId, nodeIds);
        // Send buffered messages for each subscribed node
        for (const nodeId of nodeIds) {
          const buffer = this.buffers.get(nodeId);
          if (buffer) {
            for (const buffered of buffer.getAll()) {
              ws.send(JSON.stringify(buffered));
            }
          }
        }
        break;
      }
      case 'unsubscribe': {
        if (!Array.isArray(msg.nodeIds)) {
          console.warn('[WsServer] Invalid message: nodeIds must be an array, got:', typeof msg.nodeIds);
          return;
        }
        const nodeIds = msg.nodeIds as string[];
        if (nodeIds.length > 100) {
          console.warn('[WsServer] Unsubscribe array too large:', nodeIds.length);
          return;
        }
        this.subscriptions.unsubscribe(clientId, nodeIds);
        break;
      }
      case 'subscribe_project': {
        if (typeof msg.projectId !== 'string') {
          console.warn('[WsServer] Invalid subscribe_project: projectId must be a string');
          return;
        }
        const projectId = msg.projectId as string;
        this.projectSubscriptions.subscribe(clientId, [projectId]);
        // Send current project tasks snapshot
        if (this.taskStore) {
          const tasks = this.taskStore.getTasksByProject(projectId);
          const summaries = tasks.map(t => this.taskStore!.toSummary(t));
          ws.send(JSON.stringify({
            type: 'project_tasks_snapshot',
            projectId,
            tasks: summaries,
          }));
        }
        break;
      }
      case 'unsubscribe_project': {
        if (typeof msg.projectId !== 'string') {
          console.warn('[WsServer] Invalid unsubscribe_project: projectId must be a string');
          return;
        }
        this.projectSubscriptions.unsubscribe(clientId, [msg.projectId as string]);
        break;
      }
      case 'approve_plan': {
        if (typeof msg.taskId !== 'string') {
          console.warn('[WsServer] Invalid message: taskId must be a string, got:', typeof msg.taskId);
          return;
        }
        this.taskStore?.approveTask(msg.taskId as string);
        break;
      }
      case 'reject_plan': {
        if (typeof msg.taskId !== 'string') {
          console.warn('[WsServer] Invalid message: taskId must be a string, got:', typeof msg.taskId);
          return;
        }
        this.taskStore?.rejectTask(msg.taskId as string, msg.feedback as string | undefined);
        break;
      }
      case 'cancel': {
        if (typeof msg.taskId !== 'string') {
          console.warn('[WsServer] Invalid message: taskId must be a string, got:', typeof msg.taskId);
          return;
        }
        this.taskStore?.cancelTask(msg.taskId as string);
        break;
      }
      case 'execute_task': {
        if (typeof msg.taskId !== 'string') {
          console.warn('[WsServer] Invalid execute_task: taskId must be a string');
          return;
        }
        this.taskStore?.executeTask(msg.taskId as string);
        break;
      }
      default: {
        console.warn('[WsServer] Unknown message type:', msg.type);
      }
    }
  }

  private cleanup(clientId: string): void {
    this.subscriptions.removeClient(clientId);
    this.projectSubscriptions.removeClient(clientId);
    this.clients.delete(clientId);
  }
}
