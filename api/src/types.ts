/**
 * @file Shared Hono type definitions
 * @purpose Provides Bindings and Variables interfaces used across routes
 */

export interface Bindings {
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  ALLOWED_ORIGIN: string;
}

export interface Variables {
  userId: string;
  validatedBody: unknown;
  validatedQuery: unknown;
}

export type AppEnv = { Bindings: Bindings; Variables: Variables };
