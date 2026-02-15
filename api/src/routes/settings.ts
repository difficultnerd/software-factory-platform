/**
 * @file Settings routes
 * @purpose Manages user API key storage via Supabase Vault
 * @invariants Keys are stored encrypted; GET never returns full key
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../types.js';
import { createServiceClient } from '../lib/supabase.js';
import { validateBody } from '../middleware/validation.js';
import { logger } from '../lib/logger.js';

const apiKeySchema = z.object({
  apiKey: z.string().min(20).max(200).startsWith('sk-ant-'),
});

export const settings = new Hono<AppEnv>();

settings.get('/api-key', async (c) => {
  const userId = c.get('userId');
  const supabase = createServiceClient(c.env);

  const { data: exists, error: checkError } = await supabase.rpc(
    'check_user_secret_exists',
    { p_user_id: userId, p_name: 'anthropic_key' },
  );

  if (checkError) {
    logger.error({
      event: 'settings.api_key.check',
      actor: userId,
      outcome: 'failure',
      metadata: { error: checkError.message },
    });
    return c.json({ error: 'Failed to check API key status' }, 500);
  }

  if (!exists) {
    logger.info({ event: 'settings.api_key.check', actor: userId, outcome: 'success', metadata: { exists: false } });
    return c.json({ exists: false });
  }

  const { data: secret, error: readError } = await supabase.rpc(
    'read_user_secret',
    { p_user_id: userId, p_name: 'anthropic_key' },
  );

  if (readError) {
    logger.error({
      event: 'settings.api_key.read',
      actor: userId,
      outcome: 'failure',
      metadata: { error: readError.message },
    });
    return c.json({ error: 'Failed to read API key' }, 500);
  }

  const secretStr = String(secret ?? '');
  const hint = secretStr.length >= 4 ? `...${secretStr.slice(-4)}` : '';

  logger.info({ event: 'settings.api_key.check', actor: userId, outcome: 'success', metadata: { exists: true } });
  return c.json({ exists: true, hint });
});

settings.post('/api-key', validateBody(apiKeySchema), async (c) => {
  const userId = c.get('userId');
  const { apiKey } = c.get('validatedBody') as z.infer<typeof apiKeySchema>;
  const supabase = createServiceClient(c.env);

  const { error: storeError } = await supabase.rpc('store_user_secret', {
    p_user_id: userId,
    p_name: 'anthropic_key',
    p_secret: apiKey,
    p_description: 'Anthropic API key',
  });

  if (storeError) {
    logger.error({
      event: 'settings.api_key.store',
      actor: userId,
      outcome: 'failure',
      metadata: { error: storeError.message },
    });
    return c.json({ error: 'Failed to store API key' }, 500);
  }

  logger.info({ event: 'settings.api_key.store', actor: userId, outcome: 'success' });
  return c.json({ success: true });
});

settings.delete('/api-key', async (c) => {
  const userId = c.get('userId');
  const supabase = createServiceClient(c.env);

  const { error: deleteError } = await supabase.rpc('delete_user_secret', {
    p_user_id: userId,
    p_name: 'anthropic_key',
  });

  if (deleteError) {
    logger.error({
      event: 'settings.api_key.delete',
      actor: userId,
      outcome: 'failure',
      metadata: { error: deleteError.message },
    });
    return c.json({ error: 'Failed to delete API key' }, 500);
  }

  logger.info({ event: 'settings.api_key.delete', actor: userId, outcome: 'success' });
  return c.json({ success: true });
});
