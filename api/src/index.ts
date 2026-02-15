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
import { chat } from './routes/chat.js';
import { features } from './routes/features.js';
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
app.route('/api/chat', chat);
app.route('/api/features', features);

app.get('/api/me', (c) => {
  const userId = c.get('userId');
  logger.info({ event: 'user.profile.read', actor: userId, outcome: 'success' });
  return c.json({ userId });
});

import { recoverStuckFeatures } from './lib/stuck-recovery.js';
import { processPipelineStep } from './lib/pipeline.js';
import type { PipelineMessage } from './lib/pipeline.js';
import type { Bindings } from './types.js';

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Bindings, _ctx: ExecutionContext) {
    await recoverStuckFeatures(env);
  },
  async queue(batch: MessageBatch<PipelineMessage>, env: Bindings) {
    for (const message of batch.messages) {
      try {
        await processPipelineStep(env, message.body);
        message.ack();
      } catch (err) {
        logger.error({
          event: 'queue.message.failed',
          actor: 'system',
          outcome: 'failure',
          metadata: { type: message.body.type, featureId: message.body.featureId, error: err instanceof Error ? err.message : 'Unknown' },
        });
        message.retry();
      }
    }
  },
};
