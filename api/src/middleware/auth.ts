/**
 * @file Authentication middleware
 * @purpose Verifies Supabase JWTs using JWKS (asymmetric verification)
 * @invariants All protected routes must pass through this middleware
 */
import type { MiddlewareHandler } from 'hono';
import { createRemoteJWKSet, jwtVerify } from 'jose';

interface AuthEnv {
  SUPABASE_URL: string;
}

interface AuthVariables {
  userId: string;
}

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

export const authMiddleware = (): MiddlewareHandler<{
  Bindings: AuthEnv;
  Variables: AuthVariables;
}> => {
  return async (c, next) => {
    const authHeader = c.req.header('Authorization');

    if (!authHeader?.startsWith('Bearer ')) {
      return c.json({ error: 'Missing or invalid authorization header' }, 401);
    }

    const token = authHeader.slice(7);

    try {
      if (!jwks) {
        const jwksUrl = new URL('/auth/v1/.well-known/jwks.json', c.env.SUPABASE_URL);
        jwks = createRemoteJWKSet(jwksUrl);
      }

      const { payload } = await jwtVerify(token, jwks, {
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
