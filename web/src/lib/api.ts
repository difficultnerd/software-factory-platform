/**
 * @file API client
 * @purpose Typed fetch wrapper for authenticated API calls
 */
import { PUBLIC_API_URL } from '$env/static/public';

interface ApiResult<T> {
  data: T | null;
  error: string | null;
}

export async function apiFetch<T>(
  path: string,
  token: string,
  options?: { method?: string; body?: unknown },
): Promise<ApiResult<T>> {
  const method = options?.method ?? 'GET';

  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
    };

    let bodyStr: string | undefined;
    if (options?.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      bodyStr = JSON.stringify(options.body);
    }

    const res = await fetch(`${PUBLIC_API_URL}${path}`, {
      method,
      headers,
      body: bodyStr,
    });

    const json = await res.json() as Record<string, unknown>;

    if (!res.ok) {
      const message = typeof json.error === 'string' ? json.error : 'Request failed';
      return { data: null, error: message };
    }

    return { data: json as T, error: null };
  } catch {
    return { data: null, error: 'Network error. Please try again.' };
  }
}
