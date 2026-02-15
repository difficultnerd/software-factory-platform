/**
 * @file Features routes
 * @purpose Handles feature lifecycle actions (confirm brief)
 * @invariants RLS enforces ownership; status transitions validated
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../types.js';
import { createAuthenticatedClient } from '../lib/supabase.js';
import { validateBody } from '../middleware/validation.js';
import { logger } from '../lib/logger.js';

const confirmSchema = z.object({
  briefMarkdown: z.string().min(10).max(50000),
});

export const features = new Hono<AppEnv>();

features.post('/:id/confirm', validateBody(confirmSchema), async (c) => {
  const userId = c.get('userId');
  const featureId = c.req.param('id');
  const { briefMarkdown } = c.get('validatedBody') as z.infer<typeof confirmSchema>;

  // Validate UUID format
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(featureId)) {
    return c.json({ error: 'Invalid feature ID' }, 400);
  }

  const accessToken = c.req.header('Authorization')!.slice(7);
  const authClient = createAuthenticatedClient(c.env, accessToken);

  const { data, error: updateError } = await authClient
    .from('features')
    .update({ brief_markdown: briefMarkdown, status: 'spec_generating' })
    .eq('id', featureId)
    .eq('status', 'drafting')
    .select('id')
    .single();

  if (updateError || !data) {
    // Could be not found (404) or wrong status (409)
    // Check if the feature exists at all
    const { data: existing } = await authClient
      .from('features')
      .select('id, status')
      .eq('id', featureId)
      .single();

    if (!existing) {
      return c.json({ error: 'Feature not found' }, 404);
    }

    logger.info({
      event: 'features.confirm',
      actor: userId,
      outcome: 'failure',
      metadata: { featureId, currentStatus: (existing as { status: string }).status },
    });
    return c.json({ error: 'Feature is not in drafting status' }, 409);
  }

  logger.info({
    event: 'features.confirm',
    actor: userId,
    outcome: 'success',
    metadata: { featureId },
  });

  return c.json({ success: true });
});
