/**
 * Tracks WebSocket client-to-node subscriptions with bidirectional maps
 * for efficient lookup in both directions.
 */
export class SubscriptionManager {
  /** clientId → Set<nodeId> */
  private clientToNodes = new Map<string, Set<string>>();
  /** nodeId → Set<clientId> */
  private nodeToClients = new Map<string, Set<string>>();

  /** Subscribe a client to the given node IDs. */
  subscribe(clientId: string, nodeIds: string[]): void {
    for (const nodeId of nodeIds) {
      // client → node
      let nodes = this.clientToNodes.get(clientId);
      if (!nodes) {
        nodes = new Set();
        this.clientToNodes.set(clientId, nodes);
      }
      nodes.add(nodeId);

      // node → client
      let clients = this.nodeToClients.get(nodeId);
      if (!clients) {
        clients = new Set();
        this.nodeToClients.set(nodeId, clients);
      }
      clients.add(clientId);
    }
  }

  /** Unsubscribe a client from the given node IDs. */
  unsubscribe(clientId: string, nodeIds: string[]): void {
    const nodes = this.clientToNodes.get(clientId);
    for (const nodeId of nodeIds) {
      // client → node
      if (nodes) {
        nodes.delete(nodeId);
        if (nodes.size === 0) {
          this.clientToNodes.delete(clientId);
        }
      }

      // node → client
      const clients = this.nodeToClients.get(nodeId);
      if (clients) {
        clients.delete(clientId);
        if (clients.size === 0) {
          this.nodeToClients.delete(nodeId);
        }
      }
    }
  }

  /** Remove a client and all its subscriptions (cleanup on disconnect). */
  removeClient(clientId: string): void {
    const nodes = this.clientToNodes.get(clientId);
    if (nodes) {
      for (const nodeId of nodes) {
        const clients = this.nodeToClients.get(nodeId);
        if (clients) {
          clients.delete(clientId);
          if (clients.size === 0) {
            this.nodeToClients.delete(nodeId);
          }
        }
      }
      this.clientToNodes.delete(clientId);
    }
  }

  /** Return set of clientIds subscribed to a node. */
  getSubscribers(nodeId: string): Set<string> {
    return this.nodeToClients.get(nodeId) ?? new Set();
  }

  /** Return set of nodeIds a client is subscribed to. */
  getSubscriptions(clientId: string): Set<string> {
    return this.clientToNodes.get(clientId) ?? new Set();
  }
}
