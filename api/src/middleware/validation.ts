/**
 * @file Request validation middleware
 * @purpose Validates request bodies and query parameters using Zod schemas
 * @invariants All user input must be validated before use
 */
import type { MiddlewareHandler } from 'hono';
import type { ZodType, ZodTypeDef } from 'zod';

export const validateBody = <T>(schema: ZodType<T, ZodTypeDef, unknown>): MiddlewareHandler => {
  return async (c, next) => {
    const body = await c.req.json().catch(() => null);
    if (body === null) {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    const result = schema.safeParse(body);
    if (!result.success) {
      return c.json({
        error: 'Validation failed',
        details: result.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      }, 400);
    }

    c.set('validatedBody', result.data);
    await next();
  };
};

export const validateQuery = <T>(schema: ZodType<T, ZodTypeDef, unknown>): MiddlewareHandler => {
  return async (c, next) => {
    const query = c.req.query();
    const result = schema.safeParse(query);

    if (!result.success) {
      return c.json({
        error: 'Validation failed',
        details: result.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      }, 400);
    }

    c.set('validatedQuery', result.data);
    await next();
  };
};
