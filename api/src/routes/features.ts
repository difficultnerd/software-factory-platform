/**
 * @file Features routes
 * @purpose Handles feature lifecycle: list, detail, confirm brief, approve spec/plan/tests, download
 * @invariants RLS enforces ownership; status transitions validated; agents run via queue
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../types.js';
import { createAuthenticatedClient, createServiceClient } from '../lib/supabase.js';
import { validateBody } from '../middleware/validation.js';
import { logger } from '../lib/logger.js';
import type { PipelineMessage } from '../lib/pipeline.js';
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
    .select('id, title, status, brief_markdown, spec_markdown, plan_markdown, tests_markdown, security_review_markdown, code_review_markdown, spec_recommendation, plan_recommendation, tests_recommendation, error_message, created_at, updated_at')
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
    tests_markdown: string | null;
    security_review_markdown: string | null;
    code_review_markdown: string | null;
    spec_recommendation: string | null;
    plan_recommendation: string | null;
    tests_recommendation: string | null;
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
      testsMarkdown: feature.tests_markdown,
      securityReviewMarkdown: feature.security_review_markdown,
      codeReviewMarkdown: feature.code_review_markdown,
      specRecommendation: feature.spec_recommendation,
      planRecommendation: feature.plan_recommendation,
      testsRecommendation: feature.tests_recommendation,
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

  // Enqueue spec generation
  await c.env.PIPELINE_QUEUE.send({ type: 'run_spec', featureId, userId, title: feature.title } satisfies PipelineMessage);

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
    .select('id, title, status, brief_markdown, spec_markdown')
    .eq('id', featureId)
    .single();

  if (fetchError || !feature) {
    return c.json({ error: 'Feature not found' }, 404);
  }

  const f = feature as { id: string; title: string; status: string; brief_markdown: string | null; spec_markdown: string | null };

  if (f.status !== 'spec_ready') {
    return c.json({ error: 'Feature specification is not ready for approval' }, 409);
  }

  // Transition: spec_ready -> plan_generating
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

  // Enqueue plan generation
  await c.env.PIPELINE_QUEUE.send({ type: 'run_plan', featureId, userId } satisfies PipelineMessage);

  return c.json({ success: true });
});

// Approve plan and trigger test contract generation
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
    .select('id, status, brief_markdown, spec_markdown, plan_markdown')
    .eq('id', featureId)
    .single();

  if (fetchError || !feature) {
    return c.json({ error: 'Feature not found' }, 404);
  }

  const f = feature as { id: string; status: string; brief_markdown: string | null; spec_markdown: string | null; plan_markdown: string | null };

  if (f.status !== 'plan_ready') {
    return c.json({ error: 'Feature plan is not ready for approval' }, 409);
  }

  const serviceClient = createServiceClient(c.env);
  const { error: updateError } = await serviceClient
    .from('features')
    .update({ status: 'tests_generating' })
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

  // Enqueue test contract generation
  await c.env.PIPELINE_QUEUE.send({ type: 'run_tests', featureId, userId } satisfies PipelineMessage);

  return c.json({ success: true });
});

// Approve tests and trigger implementation + review pipeline
features.post('/:id/approve-tests', async (c) => {
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

  if (f.status !== 'tests_ready') {
    return c.json({ error: 'Test contracts are not ready for approval' }, 409);
  }

  const serviceClient = createServiceClient(c.env);
  const { error: updateError } = await serviceClient
    .from('features')
    .update({ status: 'implementing' })
    .eq('id', featureId);

  if (updateError) {
    logger.error({
      event: 'features.approve_tests',
      actor: userId,
      outcome: 'failure',
      metadata: { featureId, error: updateError.message },
    });
    return c.json({ error: 'Failed to update feature status' }, 500);
  }

  logger.info({
    event: 'features.approve_tests',
    actor: userId,
    outcome: 'success',
    metadata: { featureId },
  });

  // Enqueue implementation pipeline
  await c.env.PIPELINE_QUEUE.send({ type: 'run_implement', featureId, userId } satisfies PipelineMessage);

  return c.json({ success: true });
});

// Revise brief and restart pipeline from spec generation
features.post('/:id/revise', validateBody(confirmSchema), async (c) => {
  const userId = c.get('userId');
  const featureId = c.req.param('id');
  const { briefMarkdown } = c.get('validatedBody') as z.infer<typeof confirmSchema>;

  if (!uuidRegex.test(featureId)) {
    return c.json({ error: 'Invalid feature ID' }, 400);
  }

  const accessToken = c.req.header('Authorization')!.slice(7);
  const authClient = createAuthenticatedClient(c.env, accessToken);

  // Verify feature is at an approval gate
  const { data: feature, error: fetchError } = await authClient
    .from('features')
    .select('id, title, status')
    .eq('id', featureId)
    .single();

  if (fetchError || !feature) {
    return c.json({ error: 'Feature not found' }, 404);
  }

  const f = feature as { id: string; title: string; status: string };
  const allowedStatuses = ['spec_ready', 'plan_ready', 'tests_ready'];

  if (!allowedStatuses.includes(f.status)) {
    return c.json({ error: 'Feature is not at an approval gate' }, 409);
  }

  const serviceClient = createServiceClient(c.env);

  // Delete existing artifacts from R2 (best-effort)
  const { data: artifacts } = await serviceClient
    .from('artifacts')
    .select('r2_key')
    .eq('feature_id', featureId)
    .eq('user_id', userId);

  if (artifacts && artifacts.length > 0) {
    for (const artifact of artifacts as Array<{ r2_key: string }>) {
      try {
        await c.env.ARTIFACTS.delete(artifact.r2_key);
      } catch {
        // Best-effort R2 cleanup
      }
    }
    await serviceClient
      .from('artifacts')
      .delete()
      .eq('feature_id', featureId)
      .eq('user_id', userId);
  }

  // Clear all downstream fields and restart from spec_generating
  const { error: updateError } = await serviceClient
    .from('features')
    .update({
      brief_markdown: briefMarkdown,
      status: 'spec_generating',
      spec_markdown: null,
      spec_recommendation: null,
      plan_markdown: null,
      plan_recommendation: null,
      tests_markdown: null,
      tests_recommendation: null,
      security_review_markdown: null,
      code_review_markdown: null,
      error_message: null,
    })
    .eq('id', featureId);

  if (updateError) {
    logger.error({
      event: 'features.revise',
      actor: userId,
      outcome: 'failure',
      metadata: { featureId, error: updateError.message },
    });
    return c.json({ error: 'Failed to revise feature' }, 500);
  }

  logger.info({
    event: 'features.revise',
    actor: userId,
    outcome: 'success',
    metadata: { featureId },
  });

  // Enqueue spec generation with revised brief
  await c.env.PIPELINE_QUEUE.send({ type: 'run_spec', featureId, userId, title: f.title } satisfies PipelineMessage);

  return c.json({ success: true });
});

// Retry from last checkpoint after failure
features.post('/:id/retry', async (c) => {
  const userId = c.get('userId');
  const featureId = c.req.param('id');

  if (!uuidRegex.test(featureId)) {
    return c.json({ error: 'Invalid feature ID' }, 400);
  }

  const accessToken = c.req.header('Authorization')!.slice(7);
  const authClient = createAuthenticatedClient(c.env, accessToken);

  const { data: feature, error: fetchError } = await authClient
    .from('features')
    .select('id, title, status, brief_markdown, spec_markdown, plan_markdown, tests_markdown')
    .eq('id', featureId)
    .single();

  if (fetchError || !feature) {
    return c.json({ error: 'Feature not found' }, 404);
  }

  const f = feature as {
    id: string;
    title: string;
    status: string;
    brief_markdown: string | null;
    spec_markdown: string | null;
    plan_markdown: string | null;
    tests_markdown: string | null;
  };

  if (f.status !== 'failed') {
    return c.json({ error: 'Feature is not in failed status' }, 409);
  }

  const serviceClient = createServiceClient(c.env);

  // Determine last checkpoint based on existing deliverables
  let targetStatus: string;

  if (f.tests_markdown) {
    // Tests existed — clear security/code review, delete artifacts, re-run from tests_ready
    const { data: artifacts } = await serviceClient
      .from('artifacts')
      .select('r2_key')
      .eq('feature_id', featureId)
      .eq('user_id', userId);

    if (artifacts && artifacts.length > 0) {
      for (const artifact of artifacts as Array<{ r2_key: string }>) {
        try {
          await c.env.ARTIFACTS.delete(artifact.r2_key);
        } catch {
          // Best-effort R2 cleanup
        }
      }
      await serviceClient
        .from('artifacts')
        .delete()
        .eq('feature_id', featureId)
        .eq('user_id', userId);
    }

    await serviceClient
      .from('features')
      .update({
        status: 'tests_ready',
        security_review_markdown: null,
        code_review_markdown: null,
        error_message: null,
      })
      .eq('id', featureId);

    targetStatus = 'tests_ready';
  } else if (f.plan_markdown) {
    // Plan existed — clear tests + downstream
    await serviceClient
      .from('features')
      .update({
        status: 'plan_ready',
        tests_markdown: null,
        tests_recommendation: null,
        security_review_markdown: null,
        code_review_markdown: null,
        error_message: null,
      })
      .eq('id', featureId);

    targetStatus = 'plan_ready';
  } else if (f.spec_markdown) {
    // Spec existed — clear plan + downstream
    await serviceClient
      .from('features')
      .update({
        status: 'spec_ready',
        plan_markdown: null,
        plan_recommendation: null,
        tests_markdown: null,
        tests_recommendation: null,
        security_review_markdown: null,
        code_review_markdown: null,
        error_message: null,
      })
      .eq('id', featureId);

    targetStatus = 'spec_ready';
  } else {
    // Nothing exists — go back to drafting
    await serviceClient
      .from('features')
      .update({
        status: 'drafting',
        spec_markdown: null,
        spec_recommendation: null,
        plan_markdown: null,
        plan_recommendation: null,
        tests_markdown: null,
        tests_recommendation: null,
        security_review_markdown: null,
        code_review_markdown: null,
        error_message: null,
      })
      .eq('id', featureId);

    targetStatus = 'drafting';
  }

  logger.info({
    event: 'features.retry',
    actor: userId,
    outcome: 'success',
    metadata: { featureId, targetStatus },
  });

  return c.json({ success: true, targetStatus });
});

// Get token usage for a feature
features.get('/:id/usage', async (c) => {
  const userId = c.get('userId');
  const featureId = c.req.param('id');

  if (!uuidRegex.test(featureId)) {
    return c.json({ error: 'Invalid feature ID' }, 400);
  }

  const accessToken = c.req.header('Authorization')!.slice(7);
  const authClient = createAuthenticatedClient(c.env, accessToken);

  // Verify ownership
  const { data: feature, error: fetchError } = await authClient
    .from('features')
    .select('id')
    .eq('id', featureId)
    .single();

  if (fetchError || !feature) {
    return c.json({ error: 'Feature not found' }, 404);
  }

  const serviceClient = createServiceClient(c.env);
  const { data: runs, error: runsError } = await serviceClient
    .from('agent_runs')
    .select('agent_name, input_tokens, output_tokens')
    .eq('feature_id', featureId)
    .eq('user_id', userId)
    .eq('status', 'success')
    .order('created_at', { ascending: true });

  if (runsError) {
    return c.json({ error: 'Failed to load usage data' }, 500);
  }

  const typedRuns = (runs ?? []) as Array<{ agent_name: string; input_tokens: number; output_tokens: number }>;

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  const runsList = typedRuns.map((r) => {
    totalInputTokens += r.input_tokens;
    totalOutputTokens += r.output_tokens;
    return { agentName: r.agent_name, inputTokens: r.input_tokens, outputTokens: r.output_tokens };
  });

  return c.json({ totalInputTokens, totalOutputTokens, runs: runsList });
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

