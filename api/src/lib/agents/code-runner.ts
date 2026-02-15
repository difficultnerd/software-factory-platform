/**
 * @file Code generation runner with tool use and validation retry loop
 * @purpose Orchestrates code agent: calls Anthropic with tool use, validates output
 *          with Zod, retries with error feedback on validation failure
 * @invariants Max 2 retries; truncated output salvaged but not retried; API keys never stored
 */

import { z } from 'zod';
import { callToolCompletion } from '../anthropic.js';
import type { ToolMessage, ContentBlock } from '../anthropic.js';
import { createServiceClient } from '../supabase.js';
import { logger } from '../logger.js';
import { getCodeSystemPrompt, getCodeUserPrompt, WRITE_FILES_TOOL } from './code-prompt.js';
import type { Bindings } from '../../types.js';

// --- Validation schemas ---

const CodeFileSchema = z.object({
  path: z.string().min(1).max(500)
    .regex(/^[a-zA-Z0-9]/, 'Must start with alphanumeric')
    .refine(p => !p.includes('..'), 'Must not contain ".."'),
  content: z.string().min(1, 'Must not be empty'),
});

const CodeFilesSchema = z.array(CodeFileSchema)
  .min(1, 'At least one file required')
  .refine(
    files => new Set(files.map(f => f.path)).size === files.length,
    'No duplicate paths',
  );

export interface CodeFile {
  path: string;
  content: string;
}

export type CodeRunnerResult =
  | { ok: true; files: CodeFile[]; wasTruncated: boolean; totalInputTokens: number; totalOutputTokens: number; attempts: number }
  | { ok: false; error: string };

interface CodeRunnerParams {
  featureId: string;
  userId: string;
  apiKey: string;
  specMarkdown: string;
  planMarkdown: string;
  env: Bindings;
  maxTokens?: number;
  model?: string;
}

const MAX_RETRIES = 2;

export async function runCodeAgentWithToolUse(params: CodeRunnerParams): Promise<CodeRunnerResult> {
  const { featureId, userId, apiKey, specMarkdown, planMarkdown, env, maxTokens = 64000, model } = params;
  const serviceClient = createServiceClient(env);

  const systemPrompt = getCodeSystemPrompt();
  const userPrompt = getCodeUserPrompt(specMarkdown, planMarkdown);

  // Build initial messages
  const messages: ToolMessage[] = [
    { role: 'user', content: userPrompt },
  ];

  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    logger.info({
      event: 'agent.implementer.attempt',
      actor: userId,
      outcome: 'info',
      metadata: { featureId, attempt },
    });

    const result = await callToolCompletion(
      apiKey,
      messages,
      systemPrompt,
      [WRITE_FILES_TOOL],
      maxTokens,
      { type: 'tool', name: 'write_files' },
      model,
    );

    if (!result.ok) {
      // Truncation that couldn't be salvaged — retry with smaller output request
      if (result.error.includes('truncated') && attempt < MAX_RETRIES) {
        logger.info({
          event: 'agent.implementer.truncation_retry',
          actor: userId,
          outcome: 'info',
          metadata: { featureId, attempt, error: result.error },
        });
        // Reset messages and retry — the model will try again from scratch
        messages.length = 1; // keep only the original user prompt
        continue;
      }
      // Genuine API error — log and return immediately, no retry
      await logAgentRun(serviceClient, featureId, userId, 'failed', 0, 0, result.error);
      return { ok: false, error: result.error };
    }

    totalInputTokens += result.inputTokens;
    totalOutputTokens += result.outputTokens;

    // Extract files from tool input
    const rawFiles = result.input.files;

    // Handle truncation: salvage what we can, don't retry
    if (result.stopReason === 'max_tokens') {
      logger.info({
        event: 'agent.implementer.truncated',
        actor: userId,
        outcome: 'info',
        metadata: { featureId, attempt },
      });

      if (!Array.isArray(rawFiles) || rawFiles.length === 0) {
        await logAgentRun(serviceClient, featureId, userId, 'failed', totalInputTokens, totalOutputTokens, 'Output truncated, no files recovered');
        return { ok: false, error: 'Code generation output was truncated and no complete files could be recovered. Please try again with a simpler feature.' };
      }

      // Validate individually — keep only valid files
      const validFiles: CodeFile[] = [];
      for (const raw of rawFiles) {
        const parsed = CodeFileSchema.safeParse(raw);
        if (parsed.success) {
          validFiles.push(parsed.data);
        }
      }

      if (validFiles.length === 0) {
        await logAgentRun(serviceClient, featureId, userId, 'failed', totalInputTokens, totalOutputTokens, 'Output truncated, no valid files recovered');
        return { ok: false, error: 'Code generation output was truncated and no complete files could be recovered. Please try again with a simpler feature.' };
      }

      await logAgentRun(serviceClient, featureId, userId, 'success', totalInputTokens, totalOutputTokens);

      return {
        ok: true,
        files: validFiles,
        wasTruncated: true,
        totalInputTokens,
        totalOutputTokens,
        attempts: attempt + 1,
      };
    }

    // Validate the full output with Zod
    const validation = CodeFilesSchema.safeParse(rawFiles);

    if (validation.success) {
      // All good — return valid files
      await logAgentRun(serviceClient, featureId, userId, 'success', totalInputTokens, totalOutputTokens);

      return {
        ok: true,
        files: validation.data,
        wasTruncated: false,
        totalInputTokens,
        totalOutputTokens,
        attempts: attempt + 1,
      };
    }

    // Validation failed — prepare retry with error feedback
    const errorMessages = validation.error.issues
      .map(issue => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');

    logger.info({
      event: 'agent.implementer.validation_failed',
      actor: userId,
      outcome: 'info',
      metadata: { featureId, attempt, errors: errorMessages },
    });

    if (attempt < MAX_RETRIES) {
      // Append the assistant's tool call and a tool_result error for the next attempt
      const assistantContent: ContentBlock[] = [
        { type: 'tool_use', id: result.toolUseId, name: result.toolName, input: result.input },
      ];
      messages.push({ role: 'assistant', content: assistantContent });
      messages.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: result.toolUseId,
          is_error: true,
          content: `Validation failed: ${errorMessages}. Please fix these issues and call write_files again with corrected files.`,
        }],
      });
    } else {
      // Final attempt failed
      await logAgentRun(serviceClient, featureId, userId, 'failed', totalInputTokens, totalOutputTokens, `Validation failed after ${MAX_RETRIES + 1} attempts: ${errorMessages}`);
      return { ok: false, error: `Code generation produced invalid output after ${MAX_RETRIES + 1} attempts: ${errorMessages}` };
    }
  }

  // Should not reach here, but satisfy TypeScript
  return { ok: false, error: 'Unexpected code runner exit' };
}

async function logAgentRun(
  serviceClient: ReturnType<typeof createServiceClient>,
  featureId: string,
  userId: string,
  status: 'success' | 'failed',
  inputTokens: number,
  outputTokens: number,
  errorMessage?: string,
): Promise<void> {
  const { error: insertError } = await serviceClient.from('agent_runs').insert({
    feature_id: featureId,
    user_id: userId,
    agent_name: 'implementer',
    status,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    ...(errorMessage ? { error_message: errorMessage } : {}),
  });

  if (insertError) {
    logger.error({
      event: 'agent.implementer.log_run',
      actor: userId,
      outcome: 'failure',
      metadata: { featureId, error: insertError.message },
    });
  }
}
