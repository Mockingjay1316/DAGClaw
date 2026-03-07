import type { Request, Response, NextFunction } from 'express';

export function createRateLimiter(opts: { windowMs: number; max: number }) {
  const hits = new Map<string, { count: number; resetAt: number }>();

  // Periodically sweep expired entries to prevent memory leak
  const sweepInterval = setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of hits) {
      if (now > entry.resetAt) {
        hits.delete(ip);
      }
    }
  }, opts.windowMs);
  sweepInterval.unref();

  return (req: Request, res: Response, next: NextFunction): void => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    let entry = hits.get(ip);
    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + opts.windowMs };
      hits.set(ip, entry);
    }
    entry.count++;
    if (entry.count > opts.max) {
      res.status(429).json({ error: 'Too many requests' });
      return;
    }
    next();
  };
}
