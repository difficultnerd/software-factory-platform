/**
 * @file Authentication middleware
 * @purpose Verifies Supabase JWTs and extracts user identity
 * @invariants All protected routes must pass through this middleware
 */
import type { MiddlewareHandler } from 'hono';
import { jwtVerify } from 'jose';

interface AuthEnv {
  SUPABASE_JWT_SECRET: string;
}

export const authMiddleware = (): MiddlewareHandler<{ Bindings: AuthEnv }> => {
  return async (c, next) => {
    const authHeader = c.req.header('Authorization');

    if (!authHeader?.startsWith('Bearer ')) {
      return c.json({ error: 'Missing or invalid authorization header' }, 401);
    }

    const token = authHeader.slice(7);

    try {
      const secret = new TextEncoder().encode(c.env.SUPABASE_JWT_SECRET);
      const { payload } = await jwtVerify(token, secret, {
        audience: 'authenticated',
      });

      const userId = payload.sub;
      if (!userId) {
        return c.json({ error: 'Invalid token: missing subject' }, 401);
      }

      c.set('userId', userId);
      await next();
    } catch {
      return c.json({ error: 'Invalid or expired token' }, 401);
    }
  };
};
