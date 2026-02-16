/**
 * @file Pipeline queue consumer
 * @purpose Processes pipeline steps as queue messages, replacing inline agent execution
 * @invariants Each step is self-contained: reads inputs from DB, runs agent, saves output
 */

import { createServiceClient } from './supabase.js';
import { logger } from './logger.js';
import { runAgent } from './agents/runner.js';
import { callCompletion } from './anthropic.js';
import { AGENT_CONFIGS } from './agents/agent-config.js';
import { getSpecSystemPrompt, getSpecUserPrompt } from './agents/spec-prompt.js';
import { getPlanSystemPrompt, getPlanUserPrompt } from './agents/plan-prompt.js';
import { getTestSystemPrompt, getTestUserPrompt } from './agents/test-prompt.js';
import { getSecurityReviewSystemPrompt, getSecurityReviewUserPrompt } from './agents/security-review-prompt.js';
import { getCodeReviewSystemPrompt, getCodeReviewUserPrompt } from './agents/code-review-prompt.js';
import { getAlignmentReviewSystemPrompt, getSpecAlignmentUserPrompt, getPlanAlignmentUserPrompt, getTestsAlignmentUserPrompt } from './agents/alignment-review-prompt.js';
import { runCodeAgentWithToolUse } from './agents/code-runner.js';
import type { Bindings } from '../types.js';

export interface PipelineMessage {
  type: 'run_spec' | 'run_plan' | 'run_tests' | 'run_implement' | 'run_security_review' | 'run_code_review' | 'run_verdict';
  featureId: string;
  userId: string;
  /** Only for run_spec: the feature title at time of enqueue */
  title?: string;
}

// --- Helpers ---

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

function parseRiskLevel(specMarkdown: string): 'low' | 'standard' | 'high' {
  const match = specMarkdown.match(/##\s*Risk Classification[\s\S]*?\*\*(Low|Standard|High)\*\*/i);
  if (match?.[1]) return match[1].toLowerCase() as 'low' | 'standard' | 'high';
  return 'standard';
}

function parseVerdict(text: string): 'PASS' | 'FAIL' {
  const lines = text.trim().split('\n');
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 5); i--) {
    const line = lines[i]?.trim();
    if (line === 'VERDICT: PASS') return 'PASS';
    if (line === 'VERDICT: FAIL') return 'FAIL';
  }
  return 'FAIL';
}

interface FeatureRow {
  id: string;
  title: string;
  brief_markdown: string | null;
  spec_markdown: string | null;
  plan_markdown: string | null;
  tests_markdown: string | null;
}

async function fetchFeature(
  serviceClient: ReturnType<typeof createServiceClient>,
  featureId: string,
): Promise<FeatureRow | null> {
  const { data, error } = await serviceClient
    .from('features')
    .select('id, title, brief_markdown, spec_markdown, plan_markdown, tests_markdown')
    .eq('id', featureId)
    .single();

  if (error || !data) return null;
  return data as FeatureRow;
}

// --- Pipeline dispatcher ---

export async function processPipelineStep(env: Bindings, message: PipelineMessage): Promise<void> {
  switch (message.type) {
    case 'run_spec':
      return stepRunSpec(env, message);
    case 'run_plan':
      return stepRunPlan(env, message);
    case 'run_tests':
      return stepRunTests(env, message);
    case 'run_implement':
      return stepRunImplement(env, message);
    case 'run_security_review':
      return stepRunSecurityReview(env, message);
    case 'run_code_review':
      return stepRunCodeReview(env, message);
    case 'run_verdict':
      return stepRunVerdict(env, message);
  }
}

// --- Step implementations ---

async function stepRunSpec(env: Bindings, message: PipelineMessage): Promise<void> {
  const { featureId, userId, title } = message;
  const serviceClient = createServiceClient(env);

  try {
    const feature = await fetchFeature(serviceClient, featureId);
    if (!feature) return;

    const apiKey = await readApiKey(serviceClient, userId, featureId, 'spec');
    if (!apiKey) return;

    const briefMarkdown = feature.brief_markdown ?? '';
    const featureTitle = title ?? feature.title;

    const result = await runAgent({
      agentName: 'spec',
      featureId,
      userId,
      apiKey,
      systemPrompt: getSpecSystemPrompt(),
      userPrompt: getSpecUserPrompt(briefMarkdown, featureTitle),
      env,
      maxTokens: AGENT_CONFIGS.spec.maxTokens,
      model: AGENT_CONFIGS.spec.model,
    });

    if (result.ok) {
      // If spec was truncated, warn the user but still proceed (partial output is better than none)
      const specText = result.wasTruncated
        ? result.text + '\n\n---\n*Note: This specification was truncated due to length limits. Some sections may be incomplete.*'
        : result.text;

      // Generate AI title (non-critical)
      let aiTitle: string | null = null;
      try {
        const titleResult = await callCompletion(
          apiKey,
          [{ role: 'user', content: `Summarise what this software feature does in 5-8 words. Reply with ONLY the title, no quotes or punctuation at the end.\n\n${specText.slice(0, 2000)}` }],
          'You are a concise technical writer. Respond with only the short title.',
          AGENT_CONFIGS.title.maxTokens,
          AGENT_CONFIGS.title.model,
        );
        if (titleResult.ok && titleResult.text.trim().length > 0) {
          aiTitle = titleResult.text.trim().slice(0, 200);
        }
      } catch {
        // Non-critical
      }

      // Alignment review (non-critical)
      let specRecommendation: string | null = null;
      try {
        const reviewResult = await runAgent({
          agentName: 'alignment_review',
          featureId,
          userId,
          apiKey,
          systemPrompt: getAlignmentReviewSystemPrompt(),
          userPrompt: getSpecAlignmentUserPrompt(briefMarkdown, specText),
          env,
          maxTokens: AGENT_CONFIGS.alignment_review.maxTokens,
          model: AGENT_CONFIGS.alignment_review.model,
        });
        if (reviewResult.ok) {
          specRecommendation = reviewResult.text;
        }
      } catch {
        // Non-critical
      }

      const updateFields: Record<string, string | null> = {
        spec_markdown: specText,
        status: 'spec_ready',
        spec_recommendation: specRecommendation,
      };
      if (aiTitle) {
        updateFields.title = aiTitle;
      }
      if (result.wasTruncated) {
        updateFields.error_message = 'Specification output was truncated due to length limits. Some sections may be incomplete.';
      }

      const { error: saveError } = await serviceClient
        .from('features')
        .update(updateFields)
        .eq('id', featureId);

      if (saveError) {
        logger.error({ event: 'agent.spec.save', actor: userId, outcome: 'failure', metadata: { featureId, error: saveError.message } });
        await serviceClient.from('features').update({ status: 'failed', error_message: `Failed to save specification: ${saveError.message}` }).eq('id', featureId);
      }
    } else {
      await serviceClient
        .from('features')
        .update({ status: 'failed', error_message: result.error })
        .eq('id', featureId);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error in spec agent';
    logger.error({ event: 'agent.spec.crash', actor: userId, outcome: 'failure', metadata: { featureId, error: msg } });
    try {
      await serviceClient.from('features').update({ status: 'failed', error_message: `Spec agent error: ${msg}` }).eq('id', featureId);
    } catch { /* last resort */ }
  }
}

async function stepRunPlan(env: Bindings, message: PipelineMessage): Promise<void> {
  const { featureId, userId } = message;
  const serviceClient = createServiceClient(env);

  try {
    const feature = await fetchFeature(serviceClient, featureId);
    if (!feature) return;

    const apiKey = await readApiKey(serviceClient, userId, featureId, 'planner');
    if (!apiKey) return;

    const briefMarkdown = feature.brief_markdown ?? '';
    const specMarkdown = feature.spec_markdown ?? '';

    const result = await runAgent({
      agentName: 'planner',
      featureId,
      userId,
      apiKey,
      systemPrompt: getPlanSystemPrompt(),
      userPrompt: getPlanUserPrompt(specMarkdown),
      env,
      maxTokens: AGENT_CONFIGS.planner.maxTokens,
      model: AGENT_CONFIGS.planner.model,
    });

    if (result.ok) {
      const planText = result.wasTruncated
        ? result.text + '\n\n---\n*Note: This plan was truncated due to length limits. Some sections may be incomplete.*'
        : result.text;

      let planRecommendation: string | null = null;
      try {
        const reviewResult = await runAgent({
          agentName: 'alignment_review',
          featureId,
          userId,
          apiKey,
          systemPrompt: getAlignmentReviewSystemPrompt(),
          userPrompt: getPlanAlignmentUserPrompt(briefMarkdown, specMarkdown, planText),
          env,
          maxTokens: AGENT_CONFIGS.alignment_review.maxTokens,
          model: AGENT_CONFIGS.alignment_review.model,
        });
        if (reviewResult.ok) {
          planRecommendation = reviewResult.text;
        }
      } catch {
        // Non-critical
      }

      const updateFields: Record<string, string | null> = {
        plan_markdown: planText,
        plan_recommendation: planRecommendation,
        status: 'plan_ready',
      };
      if (result.wasTruncated) {
        updateFields.error_message = 'Plan output was truncated due to length limits. Some sections may be incomplete.';
      }

      const { error: saveError } = await serviceClient
        .from('features')
        .update(updateFields)
        .eq('id', featureId);

      if (saveError) {
        logger.error({ event: 'agent.planner.save', actor: userId, outcome: 'failure', metadata: { featureId, error: saveError.message } });
        await serviceClient.from('features').update({ status: 'failed', error_message: `Failed to save plan: ${saveError.message}` }).eq('id', featureId);
      }
    } else {
      await serviceClient
        .from('features')
        .update({ status: 'failed', error_message: result.error })
        .eq('id', featureId);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error in plan agent';
    logger.error({ event: 'agent.planner.crash', actor: userId, outcome: 'failure', metadata: { featureId, error: msg } });
    try {
      await serviceClient.from('features').update({ status: 'failed', error_message: `Plan agent error: ${msg}` }).eq('id', featureId);
    } catch { /* last resort */ }
  }
}

async function stepRunTests(env: Bindings, message: PipelineMessage): Promise<void> {
  const { featureId, userId } = message;
  const serviceClient = createServiceClient(env);

  try {
    const feature = await fetchFeature(serviceClient, featureId);
    if (!feature) return;

    const apiKey = await readApiKey(serviceClient, userId, featureId, 'contract_test');
    if (!apiKey) return;

    const briefMarkdown = feature.brief_markdown ?? '';
    const specMarkdown = feature.spec_markdown ?? '';
    const planMarkdown = feature.plan_markdown ?? '';

    const result = await runAgent({
      agentName: 'contract_test',
      featureId,
      userId,
      apiKey,
      systemPrompt: getTestSystemPrompt(parseRiskLevel(specMarkdown)),
      userPrompt: getTestUserPrompt(specMarkdown, planMarkdown),
      env,
      maxTokens: AGENT_CONFIGS.contract_test.maxTokens,
      model: AGENT_CONFIGS.contract_test.model,
    });

    if (result.ok) {
      const testsText = result.wasTruncated
        ? result.text + '\n\n---\n*Note: These tests were truncated due to length limits. Some test cases may be incomplete.*'
        : result.text;

      let testsRecommendation: string | null = null;
      try {
        const reviewResult = await runAgent({
          agentName: 'alignment_review',
          featureId,
          userId,
          apiKey,
          systemPrompt: getAlignmentReviewSystemPrompt(),
          userPrompt: getTestsAlignmentUserPrompt(briefMarkdown, specMarkdown, planMarkdown, testsText),
          env,
          maxTokens: AGENT_CONFIGS.alignment_review.maxTokens,
          model: AGENT_CONFIGS.alignment_review.model,
        });
        if (reviewResult.ok) {
          testsRecommendation = reviewResult.text;
        }
      } catch {
        // Non-critical
      }

      const updateFields: Record<string, string | null> = {
        tests_markdown: testsText,
        tests_recommendation: testsRecommendation,
        status: 'tests_ready',
      };
      if (result.wasTruncated) {
        updateFields.error_message = 'Tests output was truncated due to length limits. Some test cases may be incomplete.';
      }

      const { error: saveError } = await serviceClient
        .from('features')
        .update(updateFields)
        .eq('id', featureId);

      if (saveError) {
        logger.error({ event: 'agent.contract_test.save', actor: userId, outcome: 'failure', metadata: { featureId, error: saveError.message } });
        await serviceClient.from('features').update({ status: 'failed', error_message: `Failed to save tests: ${saveError.message}` }).eq('id', featureId);
      }
    } else {
      await serviceClient
        .from('features')
        .update({ status: 'failed', error_message: result.error })
        .eq('id', featureId);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error in test agent';
    logger.error({ event: 'agent.contract_test.crash', actor: userId, outcome: 'failure', metadata: { featureId, error: msg } });
    try {
      await serviceClient.from('features').update({ status: 'failed', error_message: `Test agent error: ${msg}` }).eq('id', featureId);
    } catch { /* last resort */ }
  }
}

async function stepRunImplement(env: Bindings, message: PipelineMessage): Promise<void> {
  const { featureId, userId } = message;
  const serviceClient = createServiceClient(env);

  try {
    const feature = await fetchFeature(serviceClient, featureId);
    if (!feature) return;

    const apiKey = await readApiKey(serviceClient, userId, featureId, 'implementer');
    if (!apiKey) return;

    const specMarkdown = feature.spec_markdown ?? '';
    const planMarkdown = feature.plan_markdown ?? '';

    const codeResult = await runCodeAgentWithToolUse({
      featureId,
      userId,
      apiKey,
      specMarkdown,
      planMarkdown,
      env,
      maxTokens: AGENT_CONFIGS.implementer.maxTokens,
      model: AGENT_CONFIGS.implementer.model,
    });

    if (!codeResult.ok) {
      await serviceClient
        .from('features')
        .update({ status: 'failed', error_message: codeResult.error })
        .eq('id', featureId);
      return;
    }

    // Upload files to R2
    for (const file of codeResult.files) {
      const r2Key = `${userId}/${featureId}/${file.path}`;
      await env.ARTIFACTS.put(r2Key, file.content);

      const { error: insertError } = await serviceClient.from('artifacts').insert({
        feature_id: featureId,
        user_id: userId,
        file_path: file.path,
        r2_key: r2Key,
        size_bytes: new TextEncoder().encode(file.content).byteLength,
        artifact_type: 'implementation',
      });

      if (insertError) {
        logger.error({ event: 'agent.pipeline.artifact_insert', actor: userId, outcome: 'failure', metadata: { featureId, filePath: file.path, error: insertError.message } });
      }
    }

    // Transition to review
    const reviewUpdate: Record<string, string> = { status: 'review' };
    if (codeResult.wasTruncated) {
      reviewUpdate.error_message = `Output was truncated: ${codeResult.files.length} complete file(s) were recovered, but some files may be missing.`;
    }
    const { error: reviewTransitionError } = await serviceClient
      .from('features')
      .update(reviewUpdate)
      .eq('id', featureId);

    if (reviewTransitionError) {
      logger.error({ event: 'agent.pipeline.review_transition', actor: userId, outcome: 'failure', metadata: { featureId, error: reviewTransitionError.message } });
      await serviceClient.from('features').update({ status: 'failed', error_message: `Failed to transition to review: ${reviewTransitionError.message}` }).eq('id', featureId);
      return;
    }

    // Enqueue security review as next step
    await env.PIPELINE_QUEUE.send({ type: 'run_security_review', featureId, userId } satisfies PipelineMessage);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error in implementation pipeline';
    logger.error({ event: 'agent.pipeline.crash', actor: userId, outcome: 'failure', metadata: { featureId, error: msg } });
    try {
      await serviceClient.from('features').update({ status: 'failed', error_message: `Pipeline error: ${msg}` }).eq('id', featureId);
    } catch { /* last resort */ }
  }
}

async function stepRunSecurityReview(env: Bindings, message: PipelineMessage): Promise<void> {
  const { featureId, userId } = message;
  const serviceClient = createServiceClient(env);

  try {
    const feature = await fetchFeature(serviceClient, featureId);
    if (!feature) return;

    const apiKey = await readApiKey(serviceClient, userId, featureId, 'security_review');
    if (!apiKey) return;

    const specMarkdown = feature.spec_markdown ?? '';

    // Read artifacts to get code files
    const { data: artifacts } = await serviceClient
      .from('artifacts')
      .select('file_path, r2_key')
      .eq('feature_id', featureId)
      .eq('user_id', userId);

    const codeFiles: Array<{ path: string; content: string }> = [];
    if (artifacts) {
      for (const artifact of artifacts as Array<{ file_path: string; r2_key: string }>) {
        const r2Object = await env.ARTIFACTS.get(artifact.r2_key);
        if (r2Object) {
          codeFiles.push({ path: artifact.file_path, content: await r2Object.text() });
        }
      }
    }

    if (codeFiles.length === 0) {
      logger.error({ event: 'agent.security_review.no_files', actor: userId, outcome: 'failure', metadata: { featureId } });
      // Continue to code review anyway — verdict step will handle missing review
      await env.PIPELINE_QUEUE.send({ type: 'run_code_review', featureId, userId } satisfies PipelineMessage);
      return;
    }

    const securityResult = await runAgent({
      agentName: 'security_review',
      featureId,
      userId,
      apiKey,
      systemPrompt: getSecurityReviewSystemPrompt(parseRiskLevel(specMarkdown)),
      userPrompt: getSecurityReviewUserPrompt(codeFiles),
      env,
      maxTokens: AGENT_CONFIGS.security_review.maxTokens,
      model: AGENT_CONFIGS.security_review.model,
    });

    if (securityResult.ok) {
      // If truncated, the VERDICT line is likely missing — append explicit FAIL with explanation
      const securityText = securityResult.wasTruncated
        ? securityResult.text + '\n\n---\n*Review was truncated due to length limits.*\n\nVERDICT: FAIL'
        : securityResult.text;

      const { error: secSaveError } = await serviceClient
        .from('features')
        .update({ security_review_markdown: securityText })
        .eq('id', featureId);

      if (secSaveError) {
        logger.error({ event: 'agent.security_review.save', actor: userId, outcome: 'failure', metadata: { featureId, error: secSaveError.message } });
      }

      if (securityResult.wasTruncated) {
        logger.warn({ event: 'agent.security_review.truncated_verdict', actor: userId, outcome: 'success', metadata: { featureId } });
      }
    }

    // Enqueue code review
    await env.PIPELINE_QUEUE.send({ type: 'run_code_review', featureId, userId } satisfies PipelineMessage);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error in security review';
    logger.error({ event: 'agent.security_review.crash', actor: userId, outcome: 'failure', metadata: { featureId, error: msg } });
    try {
      await serviceClient.from('features').update({ status: 'failed', error_message: `Security review error: ${msg}` }).eq('id', featureId);
    } catch { /* last resort */ }
  }
}

async function stepRunCodeReview(env: Bindings, message: PipelineMessage): Promise<void> {
  const { featureId, userId } = message;
  const serviceClient = createServiceClient(env);

  try {
    const feature = await fetchFeature(serviceClient, featureId);
    if (!feature) return;

    const apiKey = await readApiKey(serviceClient, userId, featureId, 'code_review');
    if (!apiKey) return;

    const specMarkdown = feature.spec_markdown ?? '';
    const planMarkdown = feature.plan_markdown ?? '';

    // Read artifacts to get code files
    const { data: artifacts } = await serviceClient
      .from('artifacts')
      .select('file_path, r2_key')
      .eq('feature_id', featureId)
      .eq('user_id', userId);

    const codeFiles: Array<{ path: string; content: string }> = [];
    if (artifacts) {
      for (const artifact of artifacts as Array<{ file_path: string; r2_key: string }>) {
        const r2Object = await env.ARTIFACTS.get(artifact.r2_key);
        if (r2Object) {
          codeFiles.push({ path: artifact.file_path, content: await r2Object.text() });
        }
      }
    }

    if (codeFiles.length === 0) {
      logger.error({ event: 'agent.code_review.no_files', actor: userId, outcome: 'failure', metadata: { featureId } });
      await env.PIPELINE_QUEUE.send({ type: 'run_verdict', featureId, userId } satisfies PipelineMessage);
      return;
    }

    const codeReviewResult = await runAgent({
      agentName: 'code_review',
      featureId,
      userId,
      apiKey,
      systemPrompt: getCodeReviewSystemPrompt(),
      userPrompt: getCodeReviewUserPrompt(specMarkdown, planMarkdown, codeFiles),
      env,
      maxTokens: AGENT_CONFIGS.code_review.maxTokens,
      model: AGENT_CONFIGS.code_review.model,
    });

    if (codeReviewResult.ok) {
      // If truncated, the VERDICT line is likely missing — append explicit FAIL with explanation
      const codeReviewText = codeReviewResult.wasTruncated
        ? codeReviewResult.text + '\n\n---\n*Review was truncated due to length limits.*\n\nVERDICT: FAIL'
        : codeReviewResult.text;

      const { error: crSaveError } = await serviceClient
        .from('features')
        .update({ code_review_markdown: codeReviewText })
        .eq('id', featureId);

      if (crSaveError) {
        logger.error({ event: 'agent.code_review.save', actor: userId, outcome: 'failure', metadata: { featureId, error: crSaveError.message } });
      }

      if (codeReviewResult.wasTruncated) {
        logger.warn({ event: 'agent.code_review.truncated_verdict', actor: userId, outcome: 'success', metadata: { featureId } });
      }
    }

    // Enqueue verdict
    await env.PIPELINE_QUEUE.send({ type: 'run_verdict', featureId, userId } satisfies PipelineMessage);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error in code review';
    logger.error({ event: 'agent.code_review.crash', actor: userId, outcome: 'failure', metadata: { featureId, error: msg } });
    try {
      await serviceClient.from('features').update({ status: 'failed', error_message: `Code review error: ${msg}` }).eq('id', featureId);
    } catch { /* last resort */ }
  }
}

async function stepRunVerdict(env: Bindings, message: PipelineMessage): Promise<void> {
  const { featureId, userId } = message;
  const serviceClient = createServiceClient(env);

  try {
    const { data, error } = await serviceClient
      .from('features')
      .select('security_review_markdown, code_review_markdown')
      .eq('id', featureId)
      .single();

    if (error || !data) return;

    const f = data as { security_review_markdown: string | null; code_review_markdown: string | null };

    const securityVerdict = f.security_review_markdown ? parseVerdict(f.security_review_markdown) : 'FAIL';
    const codeReviewVerdict = f.code_review_markdown ? parseVerdict(f.code_review_markdown) : 'FAIL';

    if (securityVerdict === 'PASS' && codeReviewVerdict === 'PASS') {
      const { error: doneError } = await serviceClient
        .from('features')
        .update({ status: 'done' })
        .eq('id', featureId);

      if (doneError) {
        logger.error({ event: 'agent.pipeline.done_transition', actor: userId, outcome: 'failure', metadata: { featureId, error: doneError.message } });
      }
    } else {
      const failures: string[] = [];
      if (securityVerdict !== 'PASS') failures.push('security review');
      if (codeReviewVerdict !== 'PASS') failures.push('code review');
      const { error: failError } = await serviceClient
        .from('features')
        .update({
          status: 'failed',
          error_message: `Review failed: ${failures.join(' and ')} did not pass. See review reports for details.`,
        })
        .eq('id', featureId);

      if (failError) {
        logger.error({ event: 'agent.pipeline.fail_transition', actor: userId, outcome: 'failure', metadata: { featureId, error: failError.message } });
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error in verdict step';
    logger.error({ event: 'agent.pipeline.verdict_crash', actor: userId, outcome: 'failure', metadata: { featureId, error: msg } });
    try {
      await serviceClient.from('features').update({ status: 'failed', error_message: `Verdict error: ${msg}` }).eq('id', featureId);
    } catch { /* last resort */ }
  }
}
