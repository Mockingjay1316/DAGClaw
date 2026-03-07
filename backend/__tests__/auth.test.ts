import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import { authMiddleware } from '../src/middleware/auth.ts';

describe('Auth middleware', () => {
  let server: http.Server;
  let baseUrl: string;

  before(async () => {
    const app = express();
    app.use('/api', authMiddleware);
    app.get('/api/test', (_req, res) => {
      res.json({ ok: true });
    });

    server = http.createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, () => resolve());
    });
    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  describe('when CLAW_API_KEY is not set', () => {
    beforeEach(() => { delete process.env.CLAW_API_KEY; });

    it('allows requests without auth header', async () => {
      const res = await fetch(`${baseUrl}/api/test`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.deepEqual(body, { ok: true });
    });
  });

  describe('when CLAW_API_KEY is set', () => {
    beforeEach(() => { process.env.CLAW_API_KEY = 'test-secret-key'; });
    afterEach(() => { delete process.env.CLAW_API_KEY; });

    it('rejects requests without auth header', async () => {
      const res = await fetch(`${baseUrl}/api/test`);
      assert.equal(res.status, 401);
      const body = await res.json();
      assert.equal(body.error, 'Unauthorized');
    });

    it('rejects requests with wrong key', async () => {
      const res = await fetch(`${baseUrl}/api/test`, {
        headers: { Authorization: 'Bearer wrong-key' },
      });
      assert.equal(res.status, 401);
    });

    it('rejects requests with malformed auth header', async () => {
      const res = await fetch(`${baseUrl}/api/test`, {
        headers: { Authorization: 'Basic test-secret-key' },
      });
      assert.equal(res.status, 401);
    });

    it('allows requests with correct key', async () => {
      const res = await fetch(`${baseUrl}/api/test`, {
        headers: { Authorization: 'Bearer test-secret-key' },
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.deepEqual(body, { ok: true });
    });
  });
});
