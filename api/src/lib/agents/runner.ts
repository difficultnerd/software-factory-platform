/**
 * @file Generic agent runner
 * @purpose Calls Anthropic, logs agent_run record, returns result
 * @invariants Uses service client for agent_runs insert; never stores API keys
 */

import { callCompletion } from '../anthropic.js';
import { createServiceClient } from '../supabase.js';
import { logger } from '../logger.js';
import type { Bindings } from '../../types.js';

interface RunAgentParams {
  agentName: 'spec' | 'planner' | 'contract_test' | 'implementer' | 'security_review' | 'code_review' | 'alignment_review';
  featureId: string;
  userId: string;
  apiKey: string;
  systemPrompt: string;
  userPrompt: string;
  env: Bindings;
  maxTokens?: number;
  model?: string;
}

type RunAgentResult =
  | { ok: true; text: string; inputTokens: number; outputTokens: number; stopReason: string }
  | { ok: false; error: string };

export async function runAgent(params: RunAgentParams): Promise<RunAgentResult> {
  const { agentName, featureId, userId, apiKey, systemPrompt, userPrompt, env, maxTokens, model } = params;

  logger.info({
    event: `agent.${agentName}.start`,
    actor: userId,
    outcome: 'info',
    metadata: { featureId },
  });

  const result = await callCompletion(
    apiKey,
    [{ role: 'user', content: userPrompt }],
    systemPrompt,
    maxTokens,
    model,
  );

  const serviceClient = createServiceClient(env);

  if (result.ok) {
    // Detect truncation — treat as failure so pipeline can retry
    if (result.stopReason === 'max_tokens') {
      logger.error({
        event: `agent.${agentName}.truncated`,
        actor: userId,
        outcome: 'failure',
        metadata: { featureId, outputTokens: result.outputTokens },
      });

      const { error: insertError } = await serviceClient.from('agent_runs').insert({
        feature_id: featureId,
        user_id: userId,
        agent_name: agentName,
        status: 'failed',
        error_message: 'Output truncated',
        input_tokens: result.inputTokens,
        output_tokens: result.outputTokens,
      });

      if (insertError) {
        logger.error({
          event: `agent.${agentName}.log_run`,
          actor: userId,
          outcome: 'failure',
          metadata: { featureId, error: insertError.message },
        });
      }

      return { ok: false, error: 'Agent output was truncated. The response exceeded the maximum length.' };
    }

    // Log successful agent run
    const { error: insertError } = await serviceClient.from('agent_runs').insert({
      feature_id: featureId,
      user_id: userId,
      agent_name: agentName,
      status: 'success',
      input_tokens: result.inputTokens,
      output_tokens: result.outputTokens,
    });

    if (insertError) {
      logger.error({
        event: `agent.${agentName}.log_run`,
        actor: userId,
        outcome: 'failure',
        metadata: { featureId, error: insertError.message },
      });
    }

    logger.info({
      event: `agent.${agentName}.complete`,
      actor: userId,
      outcome: 'success',
      metadata: {
        featureId,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
      },
    });

    return result;
  }

  // Log failed agent run
  const { error: insertError } = await serviceClient.from('agent_runs').insert({
    feature_id: featureId,
    user_id: userId,
    agent_name: agentName,
    status: 'failed',
    error_message: result.error,
    input_tokens: 0,
    output_tokens: 0,
  });

  if (insertError) {
    logger.error({
      event: `agent.${agentName}.log_run`,
      actor: userId,
      outcome: 'failure',
      metadata: { featureId, error: insertError.message },
    });
  }

  logger.error({
    event: `agent.${agentName}.failed`,
    actor: userId,
    outcome: 'failure',
    metadata: { featureId, error: result.error },
  });

  return result;
}
