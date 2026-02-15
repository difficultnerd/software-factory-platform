/**
 * @file Features routes
 * @purpose Handles feature lifecycle: list, detail, confirm brief, approve spec/plan/tests, review pipeline
 * @invariants RLS enforces ownership; status transitions validated; agents run inline
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
import { getTestSystemPrompt, getTestUserPrompt } from '../lib/agents/test-prompt.js';
import { getSecurityReviewSystemPrompt, getSecurityReviewUserPrompt } from '../lib/agents/security-review-prompt.js';
import { getCodeReviewSystemPrompt, getCodeReviewUserPrompt } from '../lib/agents/code-review-prompt.js';
import { getAlignmentReviewSystemPrompt, getSpecAlignmentUserPrompt, getPlanAlignmentUserPrompt, getTestsAlignmentUserPrompt } from '../lib/agents/alignment-review-prompt.js';
import { runCodeAgentWithToolUse } from '../lib/agents/code-runner.js';
import type { CodeFile } from '../lib/agents/code-runner.js';
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

  // Run plan agent inline
  await runPlanAgent(c.env, userId, featureId, f.brief_markdown ?? '', f.spec_markdown ?? '');

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

  // Run contract test agent inline
  await runTestAgent(c.env, userId, featureId, f.brief_markdown ?? '', f.spec_markdown ?? '', f.plan_markdown ?? '');

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

  // Run implementation + review pipeline inline
  await runImplementAndReviewPipeline(c.env, userId, featureId, f.spec_markdown ?? '', f.plan_markdown ?? '');

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

  // Run spec agent inline with revised brief
  await runSpecAgent(c.env, userId, featureId, f.title, briefMarkdown);

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

// --- Helper: read API key from Vault ---

async function readApiKey(
  serviceClient: ReturnType<typeof createServiceClient>,
  userId: string,
  featureId: string,
  agentLabel: string,
): Promise<string | null> {
  const { data: apiKeyData, error: vaultError } = await serviceClient.rpc(
    'read_user_secret',
    { p_user_id: userId, p_name: 'anthropic_key' },
  );

  if (vaultError || !apiKeyData) {
    logger.error({
      event: `agent.${agentLabel}.vault_read`,
      actor: userId,
      outcome: 'failure',
      metadata: { featureId, error: vaultError?.message ?? 'No API key found' },
    });
    await serviceClient
      .from('features')
      .update({ status: 'failed', error_message: 'Failed to read API key. Please check your key in Settings.' })
      .eq('id', featureId);
    return null;
  }

  return String(apiKeyData);
}

// --- Agent runners ---

// Run spec agent
async function runSpecAgent(
  env: AppEnv['Bindings'],
  userId: string,
  featureId: string,
  title: string,
  briefMarkdown: string,
): Promise<void> {
  const serviceClient = createServiceClient(env);

  try {
    const apiKey = await readApiKey(serviceClient, userId, featureId, 'spec');
    if (!apiKey) return;

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

      // Run alignment reviewer (non-critical)
      let specRecommendation: string | null = null;
      try {
        const reviewResult = await runAgent({
          agentName: 'alignment_review',
          featureId,
          userId,
          apiKey,
          systemPrompt: getAlignmentReviewSystemPrompt(),
          userPrompt: getSpecAlignmentUserPrompt(briefMarkdown, result.text),
          env,
        });
        if (reviewResult.ok) {
          specRecommendation = reviewResult.text;
        }
      } catch {
        // Non-critical: proceed without recommendation
      }

      const updateFields: Record<string, string | null> = {
        spec_markdown: result.text,
        status: 'spec_ready',
        spec_recommendation: specRecommendation,
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

// Run plan agent
async function runPlanAgent(
  env: AppEnv['Bindings'],
  userId: string,
  featureId: string,
  briefMarkdown: string,
  specMarkdown: string,
): Promise<void> {
  const serviceClient = createServiceClient(env);

  try {
    const apiKey = await readApiKey(serviceClient, userId, featureId, 'planner');
    if (!apiKey) return;

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
      // Run alignment reviewer (non-critical)
      let planRecommendation: string | null = null;
      try {
        const reviewResult = await runAgent({
          agentName: 'alignment_review',
          featureId,
          userId,
          apiKey,
          systemPrompt: getAlignmentReviewSystemPrompt(),
          userPrompt: getPlanAlignmentUserPrompt(briefMarkdown, specMarkdown, result.text),
          env,
        });
        if (reviewResult.ok) {
          planRecommendation = reviewResult.text;
        }
      } catch {
        // Non-critical: proceed without recommendation
      }

      await serviceClient
        .from('features')
        .update({ plan_markdown: result.text, plan_recommendation: planRecommendation, status: 'plan_ready' })
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

// Run contract test agent
async function runTestAgent(
  env: AppEnv['Bindings'],
  userId: string,
  featureId: string,
  briefMarkdown: string,
  specMarkdown: string,
  planMarkdown: string,
): Promise<void> {
  const serviceClient = createServiceClient(env);

  try {
    const apiKey = await readApiKey(serviceClient, userId, featureId, 'contract_test');
    if (!apiKey) return;

    const result = await runAgent({
      agentName: 'contract_test',
      featureId,
      userId,
      apiKey,
      systemPrompt: getTestSystemPrompt(),
      userPrompt: getTestUserPrompt(specMarkdown, planMarkdown),
      env,
    });

    if (result.ok) {
      // Run alignment reviewer (non-critical)
      let testsRecommendation: string | null = null;
      try {
        const reviewResult = await runAgent({
          agentName: 'alignment_review',
          featureId,
          userId,
          apiKey,
          systemPrompt: getAlignmentReviewSystemPrompt(),
          userPrompt: getTestsAlignmentUserPrompt(briefMarkdown, specMarkdown, planMarkdown, result.text),
          env,
        });
        if (reviewResult.ok) {
          testsRecommendation = reviewResult.text;
        }
      } catch {
        // Non-critical: proceed without recommendation
      }

      await serviceClient
        .from('features')
        .update({ tests_markdown: result.text, tests_recommendation: testsRecommendation, status: 'tests_ready' })
        .eq('id', featureId);
    } else {
      await serviceClient
        .from('features')
        .update({ status: 'failed', error_message: result.error })
        .eq('id', featureId);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error in test agent';
    logger.error({
      event: 'agent.contract_test.crash',
      actor: userId,
      outcome: 'failure',
      metadata: { featureId, error: message },
    });
    try {
      await serviceClient
        .from('features')
        .update({ status: 'failed', error_message: `Test agent error: ${message}` })
        .eq('id', featureId);
    } catch { /* last resort — nothing more we can do */ }
  }
}

// Run full implementation + review pipeline (implementing -> review -> done/failed)
async function runImplementAndReviewPipeline(
  env: AppEnv['Bindings'],
  userId: string,
  featureId: string,
  specMarkdown: string,
  planMarkdown: string,
): Promise<void> {
  const serviceClient = createServiceClient(env);

  try {
    const apiKey = await readApiKey(serviceClient, userId, featureId, 'implementer');
    if (!apiKey) return;

    // Step 1: Run code agent
    const codeResult = await runCodeAgentWithToolUse({
      featureId,
      userId,
      apiKey,
      specMarkdown,
      planMarkdown,
      env,
    });

    if (!codeResult.ok) {
      await serviceClient
        .from('features')
        .update({ status: 'failed', error_message: codeResult.error })
        .eq('id', featureId);
      return;
    }

    // Upload each file to R2 and record in artifacts table
    for (const file of codeResult.files) {
      const r2Key = `${userId}/${featureId}/${file.path}`;
      await env.ARTIFACTS.put(r2Key, file.content);

      await serviceClient.from('artifacts').insert({
        feature_id: featureId,
        user_id: userId,
        file_path: file.path,
        r2_key: r2Key,
        size_bytes: new TextEncoder().encode(file.content).byteLength,
        artifact_type: 'implementation',
      });
    }

    // Transition to review
    const reviewUpdate: Record<string, string> = { status: 'review' };
    if (codeResult.wasTruncated) {
      reviewUpdate.error_message = `Output was truncated: ${codeResult.files.length} complete file(s) were recovered, but some files may be missing.`;
    }
    await serviceClient
      .from('features')
      .update(reviewUpdate)
      .eq('id', featureId);

    // Step 2: Run security review
    const securityResult = await runAgent({
      agentName: 'security_review',
      featureId,
      userId,
      apiKey,
      systemPrompt: getSecurityReviewSystemPrompt(),
      userPrompt: getSecurityReviewUserPrompt(codeResult.files),
      env,
    });

    if (securityResult.ok) {
      await serviceClient
        .from('features')
        .update({ security_review_markdown: securityResult.text })
        .eq('id', featureId);
    }

    // Step 3: Run code review
    const codeReviewResult = await runAgent({
      agentName: 'code_review',
      featureId,
      userId,
      apiKey,
      systemPrompt: getCodeReviewSystemPrompt(),
      userPrompt: getCodeReviewUserPrompt(specMarkdown, planMarkdown, codeResult.files),
      env,
    });

    if (codeReviewResult.ok) {
      await serviceClient
        .from('features')
        .update({ code_review_markdown: codeReviewResult.text })
        .eq('id', featureId);
    }

    // Step 4: Parse verdicts and determine final status
    const securityVerdict = securityResult.ok ? parseVerdict(securityResult.text) : 'FAIL';
    const codeReviewVerdict = codeReviewResult.ok ? parseVerdict(codeReviewResult.text) : 'FAIL';

    if (securityVerdict === 'PASS' && codeReviewVerdict === 'PASS') {
      await serviceClient
        .from('features')
        .update({ status: 'done' })
        .eq('id', featureId);
    } else {
      const failures: string[] = [];
      if (securityVerdict !== 'PASS') failures.push('security review');
      if (codeReviewVerdict !== 'PASS') failures.push('code review');
      await serviceClient
        .from('features')
        .update({
          status: 'failed',
          error_message: `Review failed: ${failures.join(' and ')} did not pass. See review reports for details.`,
        })
        .eq('id', featureId);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error in implementation pipeline';
    logger.error({
      event: 'agent.pipeline.crash',
      actor: userId,
      outcome: 'failure',
      metadata: { featureId, error: message },
    });
    try {
      await serviceClient
        .from('features')
        .update({ status: 'failed', error_message: `Pipeline error: ${message}` })
        .eq('id', featureId);
    } catch { /* last resort — nothing more we can do */ }
  }
}

// Extract VERDICT: PASS or VERDICT: FAIL from the last lines of agent output
function parseVerdict(text: string): 'PASS' | 'FAIL' {
  const lines = text.trim().split('\n');
  // Check last few lines for the verdict
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 5); i--) {
    const line = lines[i]?.trim();
    if (line === 'VERDICT: PASS') return 'PASS';
    if (line === 'VERDICT: FAIL') return 'FAIL';
  }
  return 'FAIL'; // Default to fail if verdict not found
}
