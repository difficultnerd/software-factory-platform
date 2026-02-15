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
import { settings } from './routes/settings.js';
import { logger } from './lib/logger.js';
import type { AppEnv } from './types.js';

const app = new Hono<AppEnv>();

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

app.route('/api/settings', settings);

app.get('/api/me', (c) => {
  const userId = c.get('userId');
  logger.info({ event: 'user.profile.read', actor: userId, outcome: 'success' });
  return c.json({ userId });
});

export default app;
