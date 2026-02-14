/**
 * @file Supabase client factory
 * @purpose Creates Supabase clients with appropriate credentials
 * @invariants Authenticated client uses user JWT; service client uses service role key
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

interface SupabaseEnv {
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
}

/**
 * Creates a Supabase client authenticated as the requesting user.
 * RLS policies will scope all queries to this user.
 */
export function createAuthenticatedClient(
  env: SupabaseEnv,
  accessToken: string,
): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    global: {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

/**
 * Creates a Supabase client with service role privileges.
 * Bypasses RLS. Use only for admin operations (vault access, etc).
 */
export function createServiceClient(env: SupabaseEnv): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}
