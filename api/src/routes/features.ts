/**
 * @file Features routes
 * @purpose Handles feature lifecycle: list, detail, confirm brief, approve spec/plan
 * @invariants RLS enforces ownership; status transitions validated; agents run via waitUntil
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../types.js';
import { createAuthenticatedClient, createServiceClient } from '../lib/supabase.js';
import { validateBody } from '../middleware/validation.js';
import { logger } from '../lib/logger.js';
import { runAgent } from '../lib/agents/runner.js';
import { getSpecSystemPrompt, getSpecUserPrompt } from '../lib/agents/spec-prompt.js';
import { getPlanSystemPrompt, getPlanUserPrompt } from '../lib/agents/plan-prompt.js';

const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const confirmSchema = z.object({
  briefMarkdown: z.string().min(10).max(50000),
});

export const features = new Hono<AppEnv>();

// List user's features
features.get('/', async (c) => {
  const userId = c.get('userId');
  const accessToken = c.req.header('Authorization')!.slice(7);
  const authClient = createAuthenticatedClient(c.env, accessToken);

  const { data, error: fetchError } = await authClient
    .from('features')
    .select('id, title, status, created_at, updated_at')
    .order('created_at', { ascending: false });

  if (fetchError) {
    logger.error({
      event: 'features.list',
      actor: userId,
      outcome: 'failure',
      metadata: { error: fetchError.message },
    });
    return c.json({ error: 'Failed to load features' }, 500);
  }

  return c.json({ features: data ?? [] });
});

// Get feature detail
features.get('/:id', async (c) => {
  const userId = c.get('userId');
  const featureId = c.req.param('id');

  if (!uuidRegex.test(featureId)) {
    return c.json({ error: 'Invalid feature ID' }, 400);
  }

  const accessToken = c.req.header('Authorization')!.slice(7);
  const authClient = createAuthenticatedClient(c.env, accessToken);

  const { data, error: fetchError } = await authClient
    .from('features')
    .select('id, title, status, brief_markdown, spec_markdown, plan_markdown, error_message, created_at, updated_at')
    .eq('id', featureId)
    .single();

  if (fetchError || !data) {
    return c.json({ error: 'Feature not found' }, 404);
  }

  const feature = data as {
    id: string;
    title: string;
    status: string;
    brief_markdown: string | null;
    spec_markdown: string | null;
    plan_markdown: string | null;
    error_message: string | null;
    created_at: string;
    updated_at: string;
  };

  logger.info({ event: 'features.detail', actor: userId, outcome: 'success', metadata: { featureId } });

  return c.json({
    feature: {
      id: feature.id,
      title: feature.title,
      status: feature.status,
      briefMarkdown: feature.brief_markdown,
      specMarkdown: feature.spec_markdown,
      planMarkdown: feature.plan_markdown,
      errorMessage: feature.error_message,
      createdAt: feature.created_at,
      updatedAt: feature.updated_at,
    },
  });
});

// Confirm brief and trigger spec agent
features.post('/:id/confirm', validateBody(confirmSchema), async (c) => {
  const userId = c.get('userId');
  const featureId = c.req.param('id');
  const { briefMarkdown } = c.get('validatedBody') as z.infer<typeof confirmSchema>;

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
    .select('id, title')
    .single();

  if (updateError || !data) {
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

  const feature = data as { id: string; title: string };

  logger.info({
    event: 'features.confirm',
    actor: userId,
    outcome: 'success',
    metadata: { featureId },
  });

  // Run spec agent in the background
  c.executionCtx.waitUntil(
    runSpecAgent(c.env, userId, featureId, feature.title, briefMarkdown),
  );

  return c.json({ success: true });
});

// Approve specification and trigger plan agent
features.post('/:id/approve-spec', async (c) => {
  const userId = c.get('userId');
  const featureId = c.req.param('id');

  if (!uuidRegex.test(featureId)) {
    return c.json({ error: 'Invalid feature ID' }, 400);
  }

  const accessToken = c.req.header('Authorization')!.slice(7);
  const authClient = createAuthenticatedClient(c.env, accessToken);

  // Verify feature is in spec_ready status
  const { data: feature, error: fetchError } = await authClient
    .from('features')
    .select('id, title, status, spec_markdown')
    .eq('id', featureId)
    .single();

  if (fetchError || !feature) {
    return c.json({ error: 'Feature not found' }, 404);
  }

  const f = feature as { id: string; title: string; status: string; spec_markdown: string | null };

  if (f.status !== 'spec_ready') {
    return c.json({ error: 'Feature specification is not ready for approval' }, 409);
  }

  // Transition: spec_ready -> spec_approved -> plan_generating
  const serviceClient = createServiceClient(c.env);
  const { error: updateError } = await serviceClient
    .from('features')
    .update({ status: 'plan_generating' })
    .eq('id', featureId);

  if (updateError) {
    logger.error({
      event: 'features.approve_spec',
      actor: userId,
      outcome: 'failure',
      metadata: { featureId, error: updateError.message },
    });
    return c.json({ error: 'Failed to update feature status' }, 500);
  }

  logger.info({
    event: 'features.approve_spec',
    actor: userId,
    outcome: 'success',
    metadata: { featureId },
  });

  // Run plan agent in the background
  c.executionCtx.waitUntil(
    runPlanAgent(c.env, userId, featureId, f.spec_markdown ?? ''),
  );

  return c.json({ success: true });
});

// Approve plan
features.post('/:id/approve-plan', async (c) => {
  const userId = c.get('userId');
  const featureId = c.req.param('id');

  if (!uuidRegex.test(featureId)) {
    return c.json({ error: 'Invalid feature ID' }, 400);
  }

  const accessToken = c.req.header('Authorization')!.slice(7);
  const authClient = createAuthenticatedClient(c.env, accessToken);

  const { data: feature, error: fetchError } = await authClient
    .from('features')
    .select('id, status')
    .eq('id', featureId)
    .single();

  if (fetchError || !feature) {
    return c.json({ error: 'Feature not found' }, 404);
  }

  const f = feature as { id: string; status: string };

  if (f.status !== 'plan_ready') {
    return c.json({ error: 'Feature plan is not ready for approval' }, 409);
  }

  const serviceClient = createServiceClient(c.env);
  const { error: updateError } = await serviceClient
    .from('features')
    .update({ status: 'plan_approved' })
    .eq('id', featureId);

  if (updateError) {
    logger.error({
      event: 'features.approve_plan',
      actor: userId,
      outcome: 'failure',
      metadata: { featureId, error: updateError.message },
    });
    return c.json({ error: 'Failed to update feature status' }, 500);
  }

  logger.info({
    event: 'features.approve_plan',
    actor: userId,
    outcome: 'success',
    metadata: { featureId },
  });

  return c.json({ success: true });
});

// Background task: run spec agent
async function runSpecAgent(
  env: AppEnv['Bindings'],
  userId: string,
  featureId: string,
  title: string,
  briefMarkdown: string,
): Promise<void> {
  const serviceClient = createServiceClient(env);

  try {
    // Read API key from Vault
    const { data: apiKeyData, error: vaultError } = await serviceClient.rpc(
      'read_user_secret',
      { p_user_id: userId, p_name: 'anthropic_key' },
    );

    if (vaultError || !apiKeyData) {
      logger.error({
        event: 'agent.spec.vault_read',
        actor: userId,
        outcome: 'failure',
        metadata: { featureId, error: vaultError?.message ?? 'No API key found' },
      });
      await serviceClient
        .from('features')
        .update({ status: 'failed', error_message: 'Failed to read API key. Please check your key in Settings.' })
        .eq('id', featureId);
      return;
    }

    const apiKey = String(apiKeyData);

    const result = await runAgent({
      agentName: 'spec',
      featureId,
      userId,
      apiKey,
      systemPrompt: getSpecSystemPrompt(),
      userPrompt: getSpecUserPrompt(briefMarkdown, title),
      env,
    });

    if (result.ok) {
      await serviceClient
        .from('features')
        .update({ spec_markdown: result.text, status: 'spec_ready' })
        .eq('id', featureId);
    } else {
      await serviceClient
        .from('features')
        .update({ status: 'failed', error_message: result.error })
        .eq('id', featureId);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error in spec agent';
    logger.error({
      event: 'agent.spec.crash',
      actor: userId,
      outcome: 'failure',
      metadata: { featureId, error: message },
    });
    try {
      await serviceClient
        .from('features')
        .update({ status: 'failed', error_message: `Spec agent error: ${message}` })
        .eq('id', featureId);
    } catch { /* last resort — nothing more we can do */ }
  }
}

// Background task: run plan agent
async function runPlanAgent(
  env: AppEnv['Bindings'],
  userId: string,
  featureId: string,
  specMarkdown: string,
): Promise<void> {
  const serviceClient = createServiceClient(env);

  try {
    // Read API key from Vault
    const { data: apiKeyData, error: vaultError } = await serviceClient.rpc(
      'read_user_secret',
      { p_user_id: userId, p_name: 'anthropic_key' },
    );

    if (vaultError || !apiKeyData) {
      logger.error({
        event: 'agent.planner.vault_read',
        actor: userId,
        outcome: 'failure',
        metadata: { featureId, error: vaultError?.message ?? 'No API key found' },
      });
      await serviceClient
        .from('features')
        .update({ status: 'failed', error_message: 'Failed to read API key. Please check your key in Settings.' })
        .eq('id', featureId);
      return;
    }

    const apiKey = String(apiKeyData);

    const result = await runAgent({
      agentName: 'planner',
      featureId,
      userId,
      apiKey,
      systemPrompt: getPlanSystemPrompt(),
      userPrompt: getPlanUserPrompt(specMarkdown),
      env,
    });

    if (result.ok) {
      await serviceClient
        .from('features')
        .update({ plan_markdown: result.text, status: 'plan_ready' })
        .eq('id', featureId);
    } else {
      await serviceClient
        .from('features')
        .update({ status: 'failed', error_message: result.error })
        .eq('id', featureId);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error in plan agent';
    logger.error({
      event: 'agent.planner.crash',
      actor: userId,
      outcome: 'failure',
      metadata: { featureId, error: message },
    });
    try {
      await serviceClient
        .from('features')
        .update({ status: 'failed', error_message: `Plan agent error: ${message}` })
        .eq('id', featureId);
    } catch { /* last resort — nothing more we can do */ }
  }
}
