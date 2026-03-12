import type { WsServer } from './websocket/wsServer.ts';
import type { ManagedTask } from './taskStateMachine.ts';

/**
 * Manages WebSocket broadcast operations for task status changes and usage updates.
 */
export class BroadcastManager {
  private wsServer: WsServer | null = null;

  setWsServer(ws: WsServer): void {
    this.wsServer = ws;
  }

  /** Broadcast a task status change to all connected clients. */
  broadcastStatusChange(task: ManagedTask, oldStatus: string): void {
    this.wsServer?.broadcastAll({
      type: 'task_status_changed',
      taskId: task.id,
      projectId: task.projectId,
      oldStatus,
      newStatus: task.status,
    });
  }

  /** Broadcast a message to subscribers of a specific task node. */
  broadcast(nodeId: string, message: Record<string, unknown>): void {
    this.wsServer?.broadcast(nodeId, message);
  }

  /** Broadcast a message to all connected clients. */
  broadcastAll(message: Record<string, unknown>): void {
    this.wsServer?.broadcastAll(message);
  }
}
