import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

function timingSafeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Compare against self to burn constant time, then return false
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

export { timingSafeCompare };

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const apiKey = process.env.CLAW_API_KEY;
  if (!apiKey) {
    next();
    return;
  }
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ') || !timingSafeCompare(header.slice(7), apiKey)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}
