/**
 * @file Anthropic client
 * @purpose Raw fetch wrapper for Anthropic Messages API (streaming and non-streaming)
 * @invariants Never stores or logs API keys; handles partial UTF-8 and SSE buffering
 */

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

type CompletionResult =
  | { ok: true; text: string; inputTokens: number; outputTokens: number; stopReason: string }
  | { ok: false; error: string };

// --- Tool use types ---

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: { type: 'object'; properties: Record<string, unknown>; required: string[] };
}

interface ToolUseBlock { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
interface TextBlock { type: 'text'; text: string }
export type ContentBlock = ToolUseBlock | TextBlock;
export interface ToolResultContent { type: 'tool_result'; tool_use_id: string; is_error?: boolean; content: string }
export type ToolMessage =
  | { role: 'user'; content: string | ToolResultContent[] }
  | { role: 'assistant'; content: string | ContentBlock[] };

export type ToolCompletionResult =
  | { ok: true; toolUseId: string; toolName: string; input: Record<string, unknown>; inputTokens: number; outputTokens: number; stopReason: string }
  | { ok: false; error: string };

/**
 * Fetch wrapper with retry logic for transient Anthropic errors (429/529).
 * Uses exponential backoff with retry-after header support.
 */
async function fetchWithRetry(
  url: string,
  init: RequestInit,
  maxRetries: number = 3,
): Promise<Response> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await fetch(url, init);
    if (response.status === 429 || response.status === 529) {
      if (attempt === maxRetries) return response;
      const retryAfter = response.headers.get('retry-after');
      const delay = retryAfter
        ? Math.min(parseInt(retryAfter, 10) * 1000, 30000)
        : Math.min(1000 * Math.pow(2, attempt), 15000);
      await new Promise(r => setTimeout(r, delay));
      continue;
    }
    return response;
  }
  return fetch(url, init);
}

/**
 * Non-streaming completion that uses streaming internally to avoid
 * Cloudflare 524 timeouts on long-running API calls.
 */
export async function callCompletion(
  apiKey: string,
  messages: ChatMessage[],
  systemPrompt: string,
  maxTokens?: number,
  model?: string,
): Promise<CompletionResult> {
  let text = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let stopReason = 'unknown';

  try {
    for await (const event of streamChatCompletion(apiKey, messages, systemPrompt, maxTokens ?? 8192, model)) {
      if (event.type === 'text') {
        text += event.text;
      } else if (event.type === 'done') {
        inputTokens = event.inputTokens;
        outputTokens = event.outputTokens;
        stopReason = event.stopReason;
      } else if (event.type === 'error') {
        return { ok: false, error: event.message };
      }
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'Unknown error';
    return { ok: false, error: `Failed to connect to AI service: ${detail}` };
  }

  if (!text) {
    return { ok: false, error: 'AI service returned empty response' };
  }

  return { ok: true, text, inputTokens, outputTokens, stopReason };
}

export type StreamEvent =
  | { type: 'text'; text: string }
  | { type: 'done'; inputTokens: number; outputTokens: number; stopReason: string }
  | { type: 'error'; message: string };

export async function* streamChatCompletion(
  apiKey: string,
  messages: ChatMessage[],
  systemPrompt: string,
  maxTokens: number = 4096,
  model: string = 'claude-sonnet-4-5-20250929',
): AsyncGenerator<StreamEvent> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
  };
  // Enable extended output for Sonnet/Opus when requesting >8192 tokens
  if (maxTokens > 8192 && !model.includes('haiku')) {
    headers['anthropic-beta'] = 'output-128k-2025-02-19';
  }

  const response = await fetchWithRetry('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      stream: true,
      system: systemPrompt,
      messages,
    }),
  });

  if (!response.ok) {
    let errorMessage = `AI service error (HTTP ${response.status})`;
    try {
      const body = await response.text();
      const parsed = JSON.parse(body) as { error?: { message?: string; type?: string } };
      if (parsed.error?.message) {
        if (response.status === 401) {
          errorMessage = 'Invalid API key. Please check your key in Settings.';
        } else if (response.status === 429 || response.status === 529) {
          errorMessage = 'The AI service is temporarily busy. Please try again in a few minutes.';
        } else if (response.status === 400) {
          errorMessage = `Request error: ${parsed.error.message}`;
        } else {
          errorMessage = `AI service error (HTTP ${response.status}): ${parsed.error.message}`;
        }
      }
    } catch {
      // Could not parse error body; keep status-code message
    }
    yield { type: 'error', message: errorMessage };
    return;
  }

  if (!response.body) {
    yield { type: 'error', message: 'No response body from AI service' };
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let stopReason = 'unknown';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Process complete SSE events (delimited by double newline)
      const parts = buffer.split('\n\n');
      // Keep the last part as it may be incomplete
      buffer = parts.pop() ?? '';

      for (const part of parts) {
        const lines = part.split('\n');
        let eventType = '';
        let data = '';

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            eventType = line.slice(7);
          } else if (line.startsWith('data: ')) {
            data = line.slice(6);
          }
        }

        if (!data) continue;

        try {
          const parsed = JSON.parse(data) as Record<string, unknown>;

          if (eventType === 'message_start') {
            const message = parsed.message as Record<string, unknown> | undefined;
            const usage = message?.usage as Record<string, number> | undefined;
            if (usage?.input_tokens) {
              inputTokens = usage.input_tokens;
            }
          } else if (eventType === 'content_block_delta') {
            const delta = parsed.delta as Record<string, unknown> | undefined;
            if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
              yield { type: 'text', text: delta.text };
            }
          } else if (eventType === 'message_delta') {
            const delta = parsed.delta as Record<string, unknown> | undefined;
            if (typeof delta?.stop_reason === 'string') {
              stopReason = delta.stop_reason;
            }
            const usage = parsed.usage as Record<string, number> | undefined;
            if (usage?.output_tokens) {
              outputTokens = usage.output_tokens;
            }
          } else if (eventType === 'message_stop') {
            yield { type: 'done', inputTokens, outputTokens, stopReason };
            return;
          } else if (eventType === 'error') {
            const error = parsed.error as Record<string, unknown> | undefined;
            const message = typeof error?.message === 'string'
              ? error.message
              : 'AI service error';
            yield { type: 'error', message };
            return;
          }
        } catch {
          // Skip unparseable SSE events
        }
      }
    }

    // If we exit the loop without message_stop, still yield done
    yield { type: 'done', inputTokens, outputTokens, stopReason };
  } finally {
    reader.releaseLock();
  }
}

/**
 * Streaming tool-use completion. Sends tools + tool_choice in the request,
 * accumulates the tool input JSON from input_json_delta events, and returns
 * the parsed input object.
 */
export async function callToolCompletion(
  apiKey: string,
  messages: ToolMessage[],
  systemPrompt: string,
  tools: ToolDefinition[],
  maxTokens: number,
  toolChoice?: { type: 'tool'; name: string } | { type: 'auto' },
  model: string = 'claude-sonnet-4-5-20250929',
): Promise<ToolCompletionResult> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
  };
  // output-128k beta only applies to Sonnet and Opus, not Haiku
  if (!model.includes('haiku')) {
    headers['anthropic-beta'] = 'output-128k-2025-02-19';
  }

  const response = await fetchWithRetry('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      stream: true,
      system: systemPrompt,
      messages,
      tools,
      ...(toolChoice ? { tool_choice: toolChoice } : {}),
    }),
  });

  if (!response.ok) {
    let errorMessage = `AI service error (HTTP ${response.status})`;
    try {
      const body = await response.text();
      const parsed = JSON.parse(body) as { error?: { message?: string; type?: string } };
      if (parsed.error?.message) {
        if (response.status === 401) {
          errorMessage = 'Invalid API key. Please check your key in Settings.';
        } else if (response.status === 429 || response.status === 529) {
          errorMessage = 'The AI service is temporarily busy. Please try again in a few minutes.';
        } else if (response.status === 400) {
          errorMessage = `Request error: ${parsed.error.message}`;
        } else {
          errorMessage = `AI service error (HTTP ${response.status}): ${parsed.error.message}`;
        }
      }
    } catch {
      // Could not parse error body; keep status-code message
    }
    return { ok: false, error: errorMessage };
  }

  if (!response.body) {
    return { ok: false, error: 'No response body from AI service' };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let stopReason = 'unknown';
  let toolUseId = '';
  let toolName = '';
  let jsonBuffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const parts = buffer.split('\n\n');
      buffer = parts.pop() ?? '';

      for (const part of parts) {
        const lines = part.split('\n');
        let eventType = '';
        let data = '';

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            eventType = line.slice(7);
          } else if (line.startsWith('data: ')) {
            data = line.slice(6);
          }
        }

        if (!data) continue;

        try {
          const parsed = JSON.parse(data) as Record<string, unknown>;

          if (eventType === 'message_start') {
            const message = parsed.message as Record<string, unknown> | undefined;
            const usage = message?.usage as Record<string, number> | undefined;
            if (usage?.input_tokens) {
              inputTokens = usage.input_tokens;
            }
          } else if (eventType === 'content_block_start') {
            const block = parsed.content_block as Record<string, unknown> | undefined;
            if (block?.type === 'tool_use') {
              toolUseId = String(block.id ?? '');
              toolName = String(block.name ?? '');
            }
          } else if (eventType === 'content_block_delta') {
            const delta = parsed.delta as Record<string, unknown> | undefined;
            if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
              jsonBuffer += delta.partial_json;
            }
          } else if (eventType === 'message_delta') {
            const delta = parsed.delta as Record<string, unknown> | undefined;
            if (typeof delta?.stop_reason === 'string') {
              stopReason = delta.stop_reason;
            }
            const usage = parsed.usage as Record<string, number> | undefined;
            if (usage?.output_tokens) {
              outputTokens = usage.output_tokens;
            }
          } else if (eventType === 'error') {
            const error = parsed.error as Record<string, unknown> | undefined;
            const message = typeof error?.message === 'string' ? error.message : 'AI service error';
            return { ok: false, error: message };
          }
        } catch {
          // Skip unparseable SSE events
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (!toolUseId) {
    return { ok: false, error: 'Model did not use the requested tool' };
  }

  // Parse the accumulated JSON
  let input: Record<string, unknown>;
  try {
    input = JSON.parse(jsonBuffer) as Record<string, unknown>;
  } catch {
    // On truncation, attempt best-effort parse
    if (stopReason === 'max_tokens') {
      const salvaged = salvageToolInput(jsonBuffer);
      if (salvaged) {
        input = salvaged;
      } else {
        return { ok: false, error: 'Code generation output was truncated and could not be recovered' };
      }
    } else {
      return { ok: false, error: 'Failed to parse tool input from AI response' };
    }
  }

  return { ok: true, toolUseId, toolName, input, inputTokens, outputTokens, stopReason };
}

/**
 * Attempts to salvage a partial { "files": [...] } JSON object from truncated
 * tool input by finding all complete file objects.
 */
function salvageToolInput(json: string): Record<string, unknown> | null {
  // Find the array start after "files":
  const filesIdx = json.indexOf('"files"');
  if (filesIdx === -1) return null;
  const arrayStart = json.indexOf('[', filesIdx);
  if (arrayStart === -1) return null;

  const results: Array<{ path: string; content: string }> = [];
  let i = arrayStart + 1;
  let objectStart = -1;
  let depth = 0;
  let inString = false;
  let escape = false;

  while (i < json.length) {
    const ch = json[i];

    if (escape) {
      escape = false;
      i++;
      continue;
    }

    if (ch === '\\' && inString) {
      escape = true;
      i++;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      i++;
      continue;
    }

    if (inString) {
      i++;
      continue;
    }

    if (ch === '{') {
      if (depth === 0) {
        objectStart = i;
      }
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && objectStart !== -1) {
        const objectText = json.slice(objectStart, i + 1);
        try {
          const obj = JSON.parse(objectText) as { path?: string; content?: string };
          if (typeof obj.path === 'string' && typeof obj.content === 'string') {
            results.push({ path: obj.path, content: obj.content });
          }
        } catch {
          // Skip malformed objects
        }
        objectStart = -1;
      }
    }

    i++;
  }

  if (results.length === 0) return null;
  return { files: results };
}
