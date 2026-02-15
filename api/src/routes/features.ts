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
import { callCompletion } from '../lib/anthropic.js';
import { getSpecSystemPrompt, getSpecUserPrompt } from '../lib/agents/spec-prompt.js';
import { getPlanSystemPrompt, getPlanUserPrompt } from '../lib/agents/plan-prompt.js';
import { getCodeSystemPrompt, getCodeUserPrompt } from '../lib/agents/code-prompt.js';
import { zipSync, strToU8 } from 'fflate';

const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const confirmSchema = z.object({
  briefMarkdown: z.string().min(10).max(50000),
});

const titleUpdateSchema = z.object({
  title: z.string().min(1).max(200),
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

// Delete a feature
features.delete('/:id', async (c) => {
  const userId = c.get('userId');
  const featureId = c.req.param('id');

  if (!uuidRegex.test(featureId)) {
    return c.json({ error: 'Invalid feature ID' }, 400);
  }

  const accessToken = c.req.header('Authorization')!.slice(7);
  const authClient = createAuthenticatedClient(c.env, accessToken);

  const { data, error: deleteError } = await authClient
    .from('features')
    .delete()
    .eq('id', featureId)
    .select('id')
    .single();

  if (deleteError || !data) {
    return c.json({ error: 'Feature not found' }, 404);
  }

  logger.info({ event: 'features.delete', actor: userId, outcome: 'success', metadata: { featureId } });

  return c.json({ success: true });
});

// Update feature title
features.patch('/:id', validateBody(titleUpdateSchema), async (c) => {
  const userId = c.get('userId');
  const featureId = c.req.param('id');
  const { title } = c.get('validatedBody') as z.infer<typeof titleUpdateSchema>;

  if (!uuidRegex.test(featureId)) {
    return c.json({ error: 'Invalid feature ID' }, 400);
  }

  const accessToken = c.req.header('Authorization')!.slice(7);
  const authClient = createAuthenticatedClient(c.env, accessToken);

  const { data, error: updateError } = await authClient
    .from('features')
    .update({ title })
    .eq('id', featureId)
    .select('id, title')
    .single();

  if (updateError || !data) {
    return c.json({ error: 'Feature not found' }, 404);
  }

  logger.info({ event: 'features.update_title', actor: userId, outcome: 'success', metadata: { featureId } });

  return c.json({ id: (data as { id: string }).id, title: (data as { title: string }).title });
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

  // Run spec agent inline (waitUntil unreliable on this Workers config)
  await runSpecAgent(c.env, userId, featureId, feature.title, briefMarkdown);

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

  // Run plan agent inline
  await runPlanAgent(c.env, userId, featureId, f.spec_markdown ?? '');

  return c.json({ success: true });
});

// Approve plan and trigger code generation
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
    .select('id, status, spec_markdown, plan_markdown')
    .eq('id', featureId)
    .single();

  if (fetchError || !feature) {
    return c.json({ error: 'Feature not found' }, 404);
  }

  const f = feature as { id: string; status: string; spec_markdown: string | null; plan_markdown: string | null };

  if (f.status !== 'plan_ready') {
    return c.json({ error: 'Feature plan is not ready for approval' }, 409);
  }

  const serviceClient = createServiceClient(c.env);
  const { error: updateError } = await serviceClient
    .from('features')
    .update({ status: 'code_generating' })
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

  // Run code agent inline
  await runCodeAgent(c.env, userId, featureId, f.spec_markdown ?? '', f.plan_markdown ?? '');

  return c.json({ success: true });
});

// Download generated code as zip
features.get('/:id/download', async (c) => {
  const userId = c.get('userId');
  const featureId = c.req.param('id');

  if (!uuidRegex.test(featureId)) {
    return c.json({ error: 'Invalid feature ID' }, 400);
  }

  const accessToken = c.req.header('Authorization')!.slice(7);
  const authClient = createAuthenticatedClient(c.env, accessToken);

  // Verify ownership and status
  const { data: feature, error: fetchError } = await authClient
    .from('features')
    .select('id, title, status')
    .eq('id', featureId)
    .single();

  if (fetchError || !feature) {
    return c.json({ error: 'Feature not found' }, 404);
  }

  const f = feature as { id: string; title: string; status: string };

  if (f.status !== 'done') {
    return c.json({ error: 'Code generation is not complete' }, 409);
  }

  // Fetch artifacts list
  const serviceClient = createServiceClient(c.env);
  const { data: artifacts, error: artifactsError } = await serviceClient
    .from('artifacts')
    .select('file_path, r2_key')
    .eq('feature_id', featureId)
    .eq('user_id', userId);

  if (artifactsError || !artifacts || artifacts.length === 0) {
    return c.json({ error: 'No artifacts found for this feature' }, 404);
  }

  const typedArtifacts = artifacts as Array<{ file_path: string; r2_key: string }>;

  // Build zip from R2 objects
  const zipData: Record<string, Uint8Array> = {};

  for (const artifact of typedArtifacts) {
    const r2Object = await c.env.ARTIFACTS.get(artifact.r2_key);
    if (r2Object) {
      const content = await r2Object.text();
      zipData[artifact.file_path] = strToU8(content);
    }
  }

  if (Object.keys(zipData).length === 0) {
    return c.json({ error: 'No files could be retrieved' }, 500);
  }

  const zipped = zipSync(zipData);

  // Sanitise title for filename
  const safeName = f.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50) || 'feature';

  return new Response(zipped, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${safeName}.zip"`,
    },
  });
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
      // Attempt to generate a concise AI title from the spec
      let aiTitle: string | null = null;
      try {
        const titleResult = await callCompletion(
          apiKey,
          [{ role: 'user', content: `Summarise what this software feature does in 5-8 words. Reply with ONLY the title, no quotes or punctuation at the end.\n\n${result.text.slice(0, 2000)}` }],
          'You are a concise technical writer. Respond with only the short title.',
          50,
        );
        if (titleResult.ok && titleResult.text.trim().length > 0) {
          aiTitle = titleResult.text.trim().slice(0, 200);
        }
      } catch {
        // Non-critical: keep original title if summarisation fails
      }

      const updateFields: Record<string, string> = {
        spec_markdown: result.text,
        status: 'spec_ready',
      };
      if (aiTitle) {
        updateFields.title = aiTitle;
      }

      await serviceClient
        .from('features')
        .update(updateFields)
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

// Background task: run code agent
async function runCodeAgent(
  env: AppEnv['Bindings'],
  userId: string,
  featureId: string,
  specMarkdown: string,
  planMarkdown: string,
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
        event: 'agent.implementer.vault_read',
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
      agentName: 'implementer',
      featureId,
      userId,
      apiKey,
      systemPrompt: getCodeSystemPrompt(),
      userPrompt: getCodeUserPrompt(specMarkdown, planMarkdown),
      env,
      maxTokens: 16384,
    });

    if (result.ok) {
      // Parse JSON output into file array
      let files: Array<{ path: string; content: string }>;
      try {
        // Strip markdown fences if the model wrapped the output
        let jsonText = result.text.trim();
        if (jsonText.startsWith('```')) {
          jsonText = jsonText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
        }
        files = JSON.parse(jsonText) as Array<{ path: string; content: string }>;
        if (!Array.isArray(files) || files.length === 0) {
          throw new Error('Expected a non-empty array of file objects');
        }
      } catch (parseErr) {
        const message = parseErr instanceof Error ? parseErr.message : 'Failed to parse code output';
        logger.error({
          event: 'agent.implementer.parse',
          actor: userId,
          outcome: 'failure',
          metadata: { featureId, error: message },
        });
        await serviceClient
          .from('features')
          .update({ status: 'failed', error_message: `Code generation produced invalid output: ${message}` })
          .eq('id', featureId);
        return;
      }

      // Upload each file to R2 and record in artifacts table
      for (const file of files) {
        const r2Key = `${userId}/${featureId}/${file.path}`;
        await env.ARTIFACTS.put(r2Key, file.content);

        await serviceClient.from('artifacts').insert({
          feature_id: featureId,
          user_id: userId,
          file_path: file.path,
          r2_key: r2Key,
          size_bytes: new TextEncoder().encode(file.content).byteLength,
        });
      }

      await serviceClient
        .from('features')
        .update({ status: 'done' })
        .eq('id', featureId);
    } else {
      await serviceClient
        .from('features')
        .update({ status: 'failed', error_message: result.error })
        .eq('id', featureId);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error in code agent';
    logger.error({
      event: 'agent.implementer.crash',
      actor: userId,
      outcome: 'failure',
      metadata: { featureId, error: message },
    });
    try {
      await serviceClient
        .from('features')
        .update({ status: 'failed', error_message: `Code agent error: ${message}` })
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
