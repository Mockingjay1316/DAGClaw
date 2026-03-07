import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import { createRateLimiter } from '../src/middleware/rateLimit.ts';

describe('Rate limiter', () => {
  let server: http.Server;
  let baseUrl: string;

  before(async () => {
    const app = express();
    app.use(express.json());
    app.post('/api/limited', createRateLimiter({ windowMs: 60_000, max: 3 }), (_req, res) => {
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

  it('allows requests under the limit', async () => {
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${baseUrl}/api/limited`, { method: 'POST' });
      assert.equal(res.status, 200);
    }
  });

  it('blocks requests over the limit', async () => {
    const res = await fetch(`${baseUrl}/api/limited`, { method: 'POST' });
    assert.equal(res.status, 429);
    const body = await res.json();
    assert.equal(body.error, 'Too many requests');
  });
});
