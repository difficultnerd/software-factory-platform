/**
 * @file API entry point
 * @purpose Configures middleware chain and routes
 * @invariants Middleware order: errors -> headers -> CORS -> auth -> routes
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { errorHandler } from './middleware/errors.js';
import { securityHeaders } from './middleware/headers.js';
import { authMiddleware } from './middleware/auth.js';
import { createAuthenticatedClient } from './lib/supabase.js';
import { logger } from './lib/logger.js';

interface Bindings {
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  SUPABASE_JWT_SECRET: string;
  ALLOWED_ORIGIN: string;
}

interface Variables {
  userId: string;
  validatedBody: unknown;
  validatedQuery: unknown;
}

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// Global middleware (order matters)
app.use('*', errorHandler());
app.use('*', securityHeaders());
app.use('*', cors({
  origin: (origin, c) => {
    const allowed = c.env.ALLOWED_ORIGIN;
    if (!origin || origin === allowed) return origin ?? '';
    return '';
  },
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
  maxAge: 86400,
}));

// Public routes
app.get('/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }));

// Protected routes: auth required
app.use('/api/*', authMiddleware());

app.get('/api/me', (c) => {
  const userId = c.get('userId');
  logger.info({ event: 'user.profile.read', actor: userId, outcome: 'success' });
  return c.json({ userId });
});

export default app;
