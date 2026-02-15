/**
 * @file Chat routes
 * @purpose Handles BA agent conversation: streaming messages and history retrieval
 * @invariants User's API key read from Vault; messages scoped by RLS; SSE streaming protocol
 */
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import type { AppEnv } from '../types.js';
import { createServiceClient, createAuthenticatedClient } from '../lib/supabase.js';
import { validateBody } from '../middleware/validation.js';
import { logger } from '../lib/logger.js';
import { streamChatCompletion } from '../lib/anthropic.js';
import { BA_SYSTEM_PROMPT } from '../lib/ba-prompt.js';

const messageSchema = z.object({
  featureId: z.string().uuid().optional(),
  message: z.string().min(1).max(10000),
});

export const chat = new Hono<AppEnv>();

chat.post('/message', validateBody(messageSchema), async (c) => {
  const userId = c.get('userId');
  const { featureId: inputFeatureId, message } = c.get('validatedBody') as z.infer<typeof messageSchema>;
  const accessToken = c.req.header('Authorization')!.slice(7);

  // Read API key from Vault (service client required)
  const serviceClient = createServiceClient(c.env);
  const { data: apiKeyData, error: vaultError } = await serviceClient.rpc(
    'read_user_secret',
    { p_user_id: userId, p_name: 'anthropic_key' },
  );

  if (vaultError) {
    logger.error({
      event: 'chat.message.vault_read',
      actor: userId,
      outcome: 'failure',
      metadata: { error: vaultError.message },
    });
    return c.json({ error: 'Failed to read API key' }, 500);
  }

  const apiKey = String(apiKeyData ?? '');
  if (!apiKey) {
    return c.json({ error: 'No API key configured. Please add your Anthropic API key in Settings.' }, 400);
  }

  // Use authenticated client for RLS-scoped operations
  const authClient = createAuthenticatedClient(c.env, accessToken);

  let featureId = inputFeatureId;

  // If no featureId, create a new feature
  if (!featureId) {
    const title = message.length > 80 ? message.slice(0, 77) + '...' : message;
    const { data: feature, error: createError } = await authClient
      .from('features')
      .insert({ user_id: userId, title, status: 'drafting' })
      .select('id')
      .single();

    if (createError || !feature) {
      logger.error({
        event: 'chat.feature.create',
        actor: userId,
        outcome: 'failure',
        metadata: { error: createError?.message },
      });
      return c.json({ error: 'Failed to create feature' }, 500);
    }

    featureId = (feature as { id: string }).id;
    logger.info({
      event: 'chat.feature.create',
      actor: userId,
      outcome: 'success',
      metadata: { featureId },
    });
  } else {
    // Verify feature exists and is in drafting status
    const { data: existing, error: fetchError } = await authClient
      .from('features')
      .select('id, status')
      .eq('id', featureId)
      .single();

    if (fetchError || !existing) {
      return c.json({ error: 'Feature not found' }, 404);
    }

    const feature = existing as { id: string; status: string };
    if (feature.status !== 'drafting') {
      return c.json({ error: 'Feature is no longer in drafting status' }, 409);
    }
  }

  // Insert user message
  const { error: insertError } = await authClient
    .from('chat_messages')
    .insert({ feature_id: featureId, user_id: userId, role: 'user', content: message });

  if (insertError) {
    logger.error({
      event: 'chat.message.insert',
      actor: userId,
      outcome: 'failure',
      metadata: { error: insertError.message, featureId },
    });
    return c.json({ error: 'Failed to save message' }, 500);
  }

  // Load full conversation history
  const { data: historyRows, error: historyError } = await authClient
    .from('chat_messages')
    .select('role, content')
    .eq('feature_id', featureId)
    .order('created_at', { ascending: true });

  if (historyError) {
    logger.error({
      event: 'chat.history.load',
      actor: userId,
      outcome: 'failure',
      metadata: { error: historyError.message, featureId },
    });
    return c.json({ error: 'Failed to load conversation history' }, 500);
  }

  const history = (historyRows ?? []) as Array<{ role: 'user' | 'assistant'; content: string }>;

  // Stream response via SSE
  const capturedFeatureId = featureId;
  return streamSSE(c, async (stream) => {
    // Send metadata first
    await stream.writeSSE({
      event: 'metadata',
      data: JSON.stringify({ featureId: capturedFeatureId }),
    });

    let fullResponse = '';

    try {
      for await (const event of streamChatCompletion(apiKey, history, BA_SYSTEM_PROMPT)) {
        if (event.type === 'text') {
          fullResponse += event.text;
          await stream.writeSSE({
            event: 'delta',
            data: JSON.stringify({ text: event.text }),
          });
        } else if (event.type === 'done') {
          await stream.writeSSE({
            event: 'done',
            data: JSON.stringify({ inputTokens: event.inputTokens, outputTokens: event.outputTokens }),
          });

          // Save assistant message after stream completes
          const { error: saveError } = await authClient
            .from('chat_messages')
            .insert({
              feature_id: capturedFeatureId,
              user_id: userId,
              role: 'assistant',
              content: fullResponse,
            });

          if (saveError) {
            logger.error({
              event: 'chat.message.save_assistant',
              actor: userId,
              outcome: 'failure',
              metadata: { error: saveError.message, featureId: capturedFeatureId },
            });
          }

          logger.info({
            event: 'chat.message.complete',
            actor: userId,
            outcome: 'success',
            metadata: {
              featureId: capturedFeatureId,
              inputTokens: event.inputTokens,
              outputTokens: event.outputTokens,
            },
          });
        } else if (event.type === 'error') {
          await stream.writeSSE({
            event: 'error',
            data: JSON.stringify({ message: event.message }),
          });
          logger.error({
            event: 'chat.message.stream_error',
            actor: userId,
            outcome: 'failure',
            metadata: { error: event.message, featureId: capturedFeatureId },
          });
        }
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown streaming error';
      await stream.writeSSE({
        event: 'error',
        data: JSON.stringify({ message: 'An error occurred while generating the response.' }),
      });
      logger.error({
        event: 'chat.message.stream_exception',
        actor: userId,
        outcome: 'failure',
        metadata: { error: errorMessage, featureId: capturedFeatureId },
      });
    }
  });
});

chat.get('/:featureId', async (c) => {
  const userId = c.get('userId');
  const featureId = c.req.param('featureId');

  // Validate UUID format
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(featureId)) {
    return c.json({ error: 'Invalid feature ID' }, 400);
  }

  const accessToken = c.req.header('Authorization')!.slice(7);
  const authClient = createAuthenticatedClient(c.env, accessToken);

  // Fetch messages and feature in parallel
  const [messagesResult, featureResult] = await Promise.all([
    authClient
      .from('chat_messages')
      .select('id, role, content, created_at')
      .eq('feature_id', featureId)
      .order('created_at', { ascending: true }),
    authClient
      .from('features')
      .select('id, title, status, brief_markdown')
      .eq('id', featureId)
      .single(),
  ]);

  if (featureResult.error || !featureResult.data) {
    return c.json({ error: 'Feature not found' }, 404);
  }

  if (messagesResult.error) {
    logger.error({
      event: 'chat.history.fetch',
      actor: userId,
      outcome: 'failure',
      metadata: { error: messagesResult.error.message, featureId },
    });
    return c.json({ error: 'Failed to load messages' }, 500);
  }

  const feature = featureResult.data as { id: string; title: string; status: string; brief_markdown: string | null };

  logger.info({ event: 'chat.history.fetch', actor: userId, outcome: 'success', metadata: { featureId } });

  return c.json({
    messages: messagesResult.data ?? [],
    feature: {
      id: feature.id,
      title: feature.title,
      status: feature.status,
      briefMarkdown: feature.brief_markdown,
    },
  });
});
