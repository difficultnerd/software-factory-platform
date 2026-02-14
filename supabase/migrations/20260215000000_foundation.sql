-- ╔══════════════════════════════════════════════════════════════════╗
-- ║  Foundation Migration: Profiles, Features, Chat, Artifacts      ║
-- ║  All tables enforce RLS with user_id = auth.uid()               ║
-- ╚══════════════════════════════════════════════════════════════════╝

-- Enable required extensions
create extension if not exists "uuid-ossp";

-- ─────────────────────────────────────────────────
-- Profiles (extends auth.users)
-- ─────────────────────────────────────────────────
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "Users can read own profile"
  on public.profiles for select
  using (auth.uid() = id);

create policy "Users can update own profile"
  on public.profiles for update
  using (auth.uid() = id);

create policy "Users can insert own profile"
  on public.profiles for insert
  with check (auth.uid() = id);

-- Auto-create profile on signup
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, new.raw_user_meta_data ->> 'display_name');
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ─────────────────────────────────────────────────
-- Features (core entity for the pipeline)
-- ─────────────────────────────────────────────────
create table public.features (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  status text not null default 'drafting'
    check (status in (
      'drafting', 'spec_generating', 'spec_ready', 'spec_approved',
      'plan_generating', 'plan_ready', 'plan_approved',
      'tests_generating', 'tests_ready', 'tests_approved',
      'implementing', 'review', 'done', 'failed'
    )),
  brief_markdown text,
  spec_markdown text,
  plan_markdown text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.features enable row level security;

create policy "Users can read own features"
  on public.features for select
  using (auth.uid() = user_id);

create policy "Users can insert own features"
  on public.features for insert
  with check (auth.uid() = user_id);

create policy "Users can update own features"
  on public.features for update
  using (auth.uid() = user_id);

create policy "Users can delete own features"
  on public.features for delete
  using (auth.uid() = user_id);

-- ─────────────────────────────────────────────────
-- Chat messages (BA agent conversations)
-- ─────────────────────────────────────────────────
create table public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  feature_id uuid references public.features(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  created_at timestamptz not null default now()
);

alter table public.chat_messages enable row level security;

create policy "Users can read own messages"
  on public.chat_messages for select
  using (auth.uid() = user_id);

create policy "Users can insert own messages"
  on public.chat_messages for insert
  with check (auth.uid() = user_id);

-- ─────────────────────────────────────────────────
-- Code artifacts (metadata; files in R2)
-- ─────────────────────────────────────────────────
create table public.artifacts (
  id uuid primary key default gen_random_uuid(),
  feature_id uuid not null references public.features(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  artifact_type text not null check (artifact_type in ('schema', 'test', 'implementation', 'migration', 'review')),
  file_path text not null,
  r2_key text not null,
  content_hash text not null,
  created_at timestamptz not null default now()
);

alter table public.artifacts enable row level security;

create policy "Users can read own artifacts"
  on public.artifacts for select
  using (auth.uid() = user_id);

create policy "Users can insert own artifacts"
  on public.artifacts for insert
  with check (auth.uid() = user_id);

-- ─────────────────────────────────────────────────
-- Agent run log (audit trail + token tracking)
-- ─────────────────────────────────────────────────
create table public.agent_runs (
  id uuid primary key default gen_random_uuid(),
  feature_id uuid not null references public.features(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  agent_name text not null check (agent_name in ('ba', 'spec', 'planner', 'contract_test', 'implementer', 'security_review', 'code_review')),
  status text not null check (status in ('running', 'success', 'failed')),
  input_tokens integer,
  output_tokens integer,
  duration_ms integer,
  error_message text,
  created_at timestamptz not null default now()
);

alter table public.agent_runs enable row level security;

create policy "Users can read own agent runs"
  on public.agent_runs for select
  using (auth.uid() = user_id);

create policy "Service role can insert agent runs"
  on public.agent_runs for insert
  with check (true);

-- ─────────────────────────────────────────────────
-- Vault helper functions (for BYOK API keys)
-- Access restricted to service_role only
-- ─────────────────────────────────────────────────
create or replace function public.store_user_secret(
  p_user_id uuid,
  p_name text,
  p_secret text,
  p_description text default null
)
returns uuid
language plpgsql
security definer set search_path = ''
as $$
declare
  v_secret_id uuid;
  v_unique_name text;
begin
  -- Create a unique name scoped to the user
  v_unique_name := p_user_id::text || '/' || p_name;

  -- Delete existing secret with same name if present
  delete from vault.secrets where name = v_unique_name;

  -- Store in vault
  select vault.create_secret(p_secret, v_unique_name, p_description)
  into v_secret_id;

  return v_secret_id;
end;
$$;

-- Restrict to service role
revoke execute on function public.store_user_secret from public;
revoke execute on function public.store_user_secret from anon;
revoke execute on function public.store_user_secret from authenticated;

create or replace function public.read_user_secret(
  p_user_id uuid,
  p_name text
)
returns text
language plpgsql
security definer set search_path = ''
as $$
declare
  v_secret text;
  v_unique_name text;
begin
  v_unique_name := p_user_id::text || '/' || p_name;

  select decrypted_secret into v_secret
  from vault.decrypted_secrets
  where name = v_unique_name;

  return v_secret;
end;
$$;

revoke execute on function public.read_user_secret from public;
revoke execute on function public.read_user_secret from anon;
revoke execute on function public.read_user_secret from authenticated;

create or replace function public.delete_user_secret(
  p_user_id uuid,
  p_name text
)
returns boolean
language plpgsql
security definer set search_path = ''
as $$
declare
  v_unique_name text;
begin
  v_unique_name := p_user_id::text || '/' || p_name;
  delete from vault.secrets where name = v_unique_name;
  return found;
end;
$$;

revoke execute on function public.delete_user_secret from public;
revoke execute on function public.delete_user_secret from anon;
revoke execute on function public.delete_user_secret from authenticated;

create or replace function public.check_user_secret_exists(
  p_user_id uuid,
  p_name text
)
returns boolean
language plpgsql
security definer set search_path = ''
as $$
declare
  v_unique_name text;
  v_exists boolean;
begin
  v_unique_name := p_user_id::text || '/' || p_name;
  select exists(select 1 from vault.secrets where name = v_unique_name) into v_exists;
  return v_exists;
end;
$$;

revoke execute on function public.check_user_secret_exists from public;
revoke execute on function public.check_user_secret_exists from anon;
revoke execute on function public.check_user_secret_exists from authenticated;

-- ─────────────────────────────────────────────────
-- Updated_at trigger
-- ─────────────────────────────────────────────────
create or replace function public.update_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_updated_at
  before update on public.profiles
  for each row execute function public.update_updated_at();

create trigger features_updated_at
  before update on public.features
  for each row execute function public.update_updated_at();
