/**
 * @file SSE parser for ReadableStream
 * @purpose Parses Server-Sent Events from a POST response body (can't use EventSource with POST)
 * @invariants Handles partial UTF-8 chunks and incomplete SSE events
 */

export interface SSEEvent {
  event: string;
  data: string;
}

export async function* parseSSE(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<SSEEvent> {
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Process complete SSE events (delimited by double newline)
      const parts = buffer.split('\n\n');
      buffer = parts.pop() ?? '';

      for (const part of parts) {
        if (!part.trim()) continue;

        const lines = part.split('\n');
        let event = 'message';
        let data = '';

        for (const line of lines) {
          if (line.startsWith('event:')) {
            event = line.slice(6).trim();
          } else if (line.startsWith('data:')) {
            data = line.slice(5).trim();
          }
        }

        if (data) {
          yield { event, data };
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
