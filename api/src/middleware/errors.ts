/**
 * @file Global error handler
 * @purpose Catches unhandled errors, returns generic responses, logs structured errors
 * @invariants Never expose internal details to clients
 */
import type { MiddlewareHandler } from 'hono';

export const errorHandler = (): MiddlewareHandler => {
  return async (c, next) => {
    try {
      await next();
    } catch (error) {
      const status = error instanceof Error && 'status' in error
        ? (error as Error & { status: number }).status
        : 500;

      const message = status >= 500 ? 'Internal server error' : (error instanceof Error ? error.message : 'Unknown error');

      if (status >= 500) {
        console.error(JSON.stringify({
          event: 'unhandled_error',
          outcome: 'failure',
          metadata: {
            error: error instanceof Error ? error.message : 'Unknown error',
            stack: error instanceof Error ? error.stack : undefined,
          },
          timestamp: new Date().toISOString(),
        }));
      }

      return c.json({ error: message }, { status: status as 500 });
    }
  };
};
