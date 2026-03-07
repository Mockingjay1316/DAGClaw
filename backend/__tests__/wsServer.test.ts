import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocket } from 'ws';
import { WsServer } from '../src/websocket/wsServer.ts';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('WsServer', () => {
  let server: http.Server;
  let wsServer: WsServer;
  let port: number;
  const openClients: WebSocket[] = [];

  function connectClient(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      openClients.push(ws);
      ws.on('open', () => resolve(ws));
      ws.on('error', reject);
    });
  }

  function collectMessages(ws: WebSocket): Record<string, unknown>[] {
    const messages: Record<string, unknown>[] = [];
    ws.on('message', (data: Buffer | string) => {
      messages.push(JSON.parse(typeof data === 'string' ? data : data.toString()));
    });
    return messages;
  }

  before((_, done) => {
    server = http.createServer();
    wsServer = new WsServer(server);
    server.listen(0, () => {
      const addr = server.address();
      port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      done();
    });
  });

  after((_, done) => {
    // Close all open clients first
    const closePromises = openClients
      .filter((ws) => ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)
      .map(
        (ws) =>
          new Promise<void>((resolve) => {
            ws.on('close', () => resolve());
            ws.close();
          }),
      );
    Promise.all(closePromises).then(() => {
      server.close(() => done());
    });
  });

  it('client can connect to WebSocket server', async () => {
    const ws = await connectClient();
    assert.equal(ws.readyState, WebSocket.OPEN);
    ws.close();
  });

  it('subscribe and receive broadcast', async () => {
    const ws = await connectClient();
    const messages = collectMessages(ws);

    ws.send(JSON.stringify({ type: 'subscribe', nodeIds: ['sub-test-1'] }));
    await delay(50);

    wsServer.broadcast('sub-test-1', { type: 'test', data: 'hello' });
    await delay(50);

    assert.equal(messages.length, 1);
    assert.deepStrictEqual(messages[0], { type: 'test', data: 'hello' });
    ws.close();
  });

  it('unsubscribe stops receiving broadcasts', async () => {
    const ws = await connectClient();
    const messages = collectMessages(ws);

    ws.send(JSON.stringify({ type: 'subscribe', nodeIds: ['unsub-test-1'] }));
    await delay(50);

    ws.send(JSON.stringify({ type: 'unsubscribe', nodeIds: ['unsub-test-1'] }));
    await delay(50);

    wsServer.broadcast('unsub-test-1', { type: 'test', data: 'should-not-receive' });
    await delay(50);

    assert.equal(messages.length, 0);
    ws.close();
  });

  it('broadcastAll sends to all clients', async () => {
    const ws1 = await connectClient();
    const ws2 = await connectClient();
    const messages1 = collectMessages(ws1);
    const messages2 = collectMessages(ws2);

    wsServer.broadcastAll({ type: 'global', info: 'everyone' });
    await delay(50);

    assert.equal(messages1.length, 1);
    assert.deepStrictEqual(messages1[0], { type: 'global', info: 'everyone' });
    assert.equal(messages2.length, 1);
    assert.deepStrictEqual(messages2[0], { type: 'global', info: 'everyone' });
    ws1.close();
    ws2.close();
  });

  it('invalid message with non-array nodeIds is handled gracefully', async () => {
    const ws = await connectClient();
    ws.send(JSON.stringify({ type: 'subscribe', nodeIds: 'not-an-array' }));
    await delay(50);

    // Connection should still be open (no crash)
    assert.equal(ws.readyState, WebSocket.OPEN);
    ws.close();
  });

  it('invalid message with non-string taskId is handled gracefully', async () => {
    const ws = await connectClient();
    ws.send(JSON.stringify({ type: 'approve_plan', taskId: 123 }));
    await delay(50);

    assert.equal(ws.readyState, WebSocket.OPEN);
    ws.close();
  });

  it('unknown message type is handled gracefully', async () => {
    const ws = await connectClient();
    ws.send(JSON.stringify({ type: 'unknown_type' }));
    await delay(50);

    assert.equal(ws.readyState, WebSocket.OPEN);
    ws.close();
  });

  it('client disconnect cleans up subscriptions', async () => {
    const ws = await connectClient();
    ws.send(JSON.stringify({ type: 'subscribe', nodeIds: ['cleanup-node'] }));
    await delay(50);

    // Close client and wait for cleanup
    await new Promise<void>((resolve) => {
      ws.on('close', () => resolve());
      ws.close();
    });
    await delay(50);

    // Broadcasting to that node after client disconnect should not throw
    assert.doesNotThrow(() => {
      wsServer.broadcast('cleanup-node', { type: 'test', data: 'after-disconnect' });
    });
  });
});
