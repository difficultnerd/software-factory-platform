/**
 * @file Security headers middleware
 * @purpose Sets security headers on all responses
 * @invariants Applied to every response without exception
 */
import type { MiddlewareHandler } from 'hono';

export const securityHeaders = (): MiddlewareHandler => {
  return async (c, next) => {
    await next();

    c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'DENY');
    c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    c.header('X-XSS-Protection', '0');
    c.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    c.header('Cache-Control', 'no-store');
  };
};
