import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { SubscriptionManager } from '../src/websocket/subscriptionManager.ts';

describe('SubscriptionManager', () => {
  let mgr: SubscriptionManager;

  beforeEach(() => {
    mgr = new SubscriptionManager();
  });

  it('subscribe adds client to node subscribers', () => {
    mgr.subscribe('c1', ['n1']);
    assert.ok(mgr.getSubscribers('n1').has('c1'));
    assert.ok(mgr.getSubscriptions('c1').has('n1'));
  });

  it('subscribe multiple nodes at once', () => {
    mgr.subscribe('c1', ['n1', 'n2', 'n3']);
    const subs = mgr.getSubscriptions('c1');
    assert.equal(subs.size, 3);
    assert.ok(subs.has('n1'));
    assert.ok(subs.has('n2'));
    assert.ok(subs.has('n3'));

    assert.ok(mgr.getSubscribers('n1').has('c1'));
    assert.ok(mgr.getSubscribers('n2').has('c1'));
    assert.ok(mgr.getSubscribers('n3').has('c1'));
  });

  it('unsubscribe removes specific node subscriptions', () => {
    mgr.subscribe('c1', ['n1', 'n2', 'n3']);
    mgr.unsubscribe('c1', ['n2']);

    const subs = mgr.getSubscriptions('c1');
    assert.equal(subs.size, 2);
    assert.ok(subs.has('n1'));
    assert.ok(!subs.has('n2'));
    assert.ok(subs.has('n3'));

    assert.equal(mgr.getSubscribers('n2').size, 0);
  });

  it('removeClient cleans up all subscriptions for that client (both directions)', () => {
    mgr.subscribe('c1', ['n1', 'n2']);
    mgr.subscribe('c2', ['n1']);

    mgr.removeClient('c1');

    assert.equal(mgr.getSubscriptions('c1').size, 0);
    assert.ok(!mgr.getSubscribers('n1').has('c1'));
    assert.equal(mgr.getSubscribers('n2').size, 0);

    // c2 should be unaffected
    assert.ok(mgr.getSubscribers('n1').has('c2'));
    assert.ok(mgr.getSubscriptions('c2').has('n1'));
  });

  it('getSubscribers returns empty set for unknown node', () => {
    const subs = mgr.getSubscribers('nonexistent');
    assert.equal(subs.size, 0);
  });

  it('getSubscriptions returns empty set for unknown client', () => {
    const subs = mgr.getSubscriptions('nonexistent');
    assert.equal(subs.size, 0);
  });

  it('multiple clients can subscribe to the same node', () => {
    mgr.subscribe('c1', ['n1']);
    mgr.subscribe('c2', ['n1']);
    mgr.subscribe('c3', ['n1']);

    const subscribers = mgr.getSubscribers('n1');
    assert.equal(subscribers.size, 3);
    assert.ok(subscribers.has('c1'));
    assert.ok(subscribers.has('c2'));
    assert.ok(subscribers.has('c3'));
  });
});
