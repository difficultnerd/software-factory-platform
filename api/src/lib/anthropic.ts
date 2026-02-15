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
  | { ok: true; text: string; inputTokens: number; outputTokens: number }
  | { ok: false; error: string };

export async function callCompletion(
  apiKey: string,
  messages: ChatMessage[],
  systemPrompt: string,
  maxTokens?: number,
): Promise<CompletionResult> {
  let response: Response;
  try {
    response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: maxTokens ?? 8192,
        stream: false,
        system: systemPrompt,
        messages,
      }),
    });
  } catch {
    return { ok: false, error: 'Failed to connect to AI service' };
  }

  if (!response.ok) {
    if (response.status === 401) {
      return { ok: false, error: 'Invalid API key. Please check your key in Settings.' };
    }
    if (response.status === 429) {
      return { ok: false, error: 'Rate limit exceeded. Please wait and try again.' };
    }
    return { ok: false, error: `AI service error (HTTP ${response.status})` };
  }

  try {
    const body = (await response.json()) as {
      content?: Array<{ type: string; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };

    const textBlock = body.content?.find((b) => b.type === 'text');
    if (!textBlock?.text) {
      return { ok: false, error: 'AI service returned empty response' };
    }

    return {
      ok: true,
      text: textBlock.text,
      inputTokens: body.usage?.input_tokens ?? 0,
      outputTokens: body.usage?.output_tokens ?? 0,
    };
  } catch {
    return { ok: false, error: 'Failed to parse AI service response' };
  }
}

export type StreamEvent =
  | { type: 'text'; text: string }
  | { type: 'done'; inputTokens: number; outputTokens: number }
  | { type: 'error'; message: string };

export async function* streamChatCompletion(
  apiKey: string,
  messages: ChatMessage[],
  systemPrompt: string,
): AsyncGenerator<StreamEvent> {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 4096,
      stream: true,
      system: systemPrompt,
      messages,
    }),
  });

  if (!response.ok) {
    let errorMessage = 'Failed to connect to AI service';
    try {
      const body = await response.text();
      const parsed = JSON.parse(body) as { error?: { message?: string } };
      if (parsed.error?.message) {
        // Sanitise: don't leak internal Anthropic details, but keep useful info
        if (response.status === 401) {
          errorMessage = 'Invalid API key. Please check your key in Settings.';
        } else if (response.status === 429) {
          errorMessage = 'Rate limit exceeded. Please wait a moment and try again.';
        } else if (response.status === 400) {
          errorMessage = 'Request error. Please try again with a shorter message.';
        }
      }
    } catch {
      // Could not parse error body; use generic message
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
            const usage = parsed.usage as Record<string, number> | undefined;
            if (usage?.output_tokens) {
              outputTokens = usage.output_tokens;
            }
          } else if (eventType === 'message_stop') {
            yield { type: 'done', inputTokens, outputTokens };
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
    yield { type: 'done', inputTokens, outputTokens };
  } finally {
    reader.releaseLock();
  }
}
