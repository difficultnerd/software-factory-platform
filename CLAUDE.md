# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Build Practical (buildpractical.com) is a multi-tenant AI-powered software platform. Non-technical users describe software in conversation with a BA agent, and a pipeline of constrained AI agents builds it: BA chat -> spec generation -> plan generation -> code generation -> download as zip.

## Live URLs

- Frontend: https://app.buildpractical.com (SvelteKit, Cloudflare Pages)
- API: https://api.buildpractical.com (Hono, Cloudflare Workers)
- Database: Supabase (https://blyljuoajecrzoyxomaj.supabase.co)

## Tech Stack

- **API**: Cloudflare Workers, Hono, TypeScript strict mode, Zod validation
- **Frontend**: SvelteKit 5 (Svelte 5 runes syntax: `$props`, `$state`, `$derived`), Tailwind CSS, Cloudflare Pages
- **Database**: Supabase PostgreSQL with RLS on ALL tables (`user_id = auth.uid()`)
- **Auth**: Supabase Auth, JWKS-based JWT verification (asymmetric, no shared secret)
- **Secrets**: Supabase Vault (encrypted at rest, service-role only via security definer functions)
- **Storage**: Cloudflare R2 (`buildpractical-artifacts` bucket) for generated code files
- **AI**: Anthropic Claude Sonnet via user BYOK keys
- **Zip**: `fflate` for Workers-compatible zip generation
- **Markdown**: `marked` for rendering spec/plan markdown in the frontend

## Build Commands

```bash
cd api && npx tsc --noEmit          # API typecheck
cd web && npx svelte-check          # Web typecheck
npm run dev:api                      # Local API dev server (port 8787)
npm run dev:web                      # Local web dev server (port 5173)
```

## Monorepo Structure

- `api/` — Cloudflare Workers (Hono)
- `web/` — SvelteKit on Cloudflare Pages
- `supabase/migrations/` — SQL migrations (run manually in Supabase SQL Editor)
- `docs/` — Architecture and governance documents
- `.github/workflows/ci.yml` — CI pipeline

## Key Conventions

- TypeScript strict mode, no `any`
- All user input validated with Zod schemas at API boundaries
- All database tables MUST have RLS policies
- User secrets stored in Supabase Vault via helper functions (`store_user_secret`, `read_user_secret`, `delete_user_secret`, `check_user_secret_exists`) — these are service-role only
- Middleware chain order: errors -> headers -> CORS -> auth -> routes
- Structured JSON logging via `api/src/lib/logger.ts`
- Australian English in UI copy (e.g. "colour", "organisation", "behaviour")
- No emojis in UI
- Supabase client patterns: authenticated client for user-scoped queries (RLS), service client for admin operations

## API Middleware Kernel

Files in `api/src/middleware/` are the security trust root. Do NOT modify without explicit approval:
- `errors.ts` — Global error handler, generic error responses
- `headers.ts` — Security headers (HSTS, CSP, X-Frame-Options, etc.)
- `auth.ts` — JWKS JWT verification, extracts `userId`
- `validation.ts` — Zod schema validation for body and query params

## Pipeline Architecture

The feature pipeline is a state machine managed in the `features` table:

```
drafting -> spec_generating -> spec_ready -> (user approves) ->
plan_generating -> plan_ready -> (user approves) ->
code_generating -> done / failed
```

Each agent phase follows the same pattern (see `api/src/routes/features.ts`):
1. Read user's API key from Vault via service client RPC
2. Call `runAgent()` with the agent's system/user prompts
3. On success: store output, transition to next status
4. On failure: set status to `failed` with error message

Agent prompts live in `api/src/lib/agents/`:
- `governance.ts` — Shared platform context injected into all prompts
- `spec-prompt.ts` — Specification agent
- `plan-prompt.ts` — Planner agent
- `code-prompt.ts` — Implementer agent (outputs JSON array of `{path, content}` file objects)
- `runner.ts` — Generic agent runner (calls Anthropic, logs `agent_runs`)

The code agent's output is parsed as JSON, each file uploaded to R2 under `{userId}/{featureId}/{filePath}`, and metadata inserted into the `artifacts` table.

## API Routes

- `api/src/routes/settings.ts` — API key management (Vault CRUD)
- `api/src/routes/chat.ts` — BA agent chat (streaming), conversation history
- `api/src/routes/features.ts` — Feature lifecycle: list, detail, delete, rename, confirm brief, approve spec/plan, download zip

## Frontend Key Pages

- `web/src/routes/app/+page.svelte` — Dashboard (feature list with status badges, inline title editing)
- `web/src/routes/app/features/+page.svelte` — Chat interface for BA agent
- `web/src/routes/app/features/[id]/+page.svelte` — Feature detail (status-specific views, markdown rendering, approve buttons, download)
- `web/src/routes/app/settings/+page.svelte` — API key management

## Database Schema

Defined in `supabase/migrations/20260215000000_foundation.sql`. Key tables:
- **profiles** — Extends `auth.users`, auto-created via trigger
- **features** — Pipeline state machine with status CHECK constraint, stores brief/spec/plan markdown
- **chat_messages** — BA agent conversation history
- **artifacts** — Generated code file metadata (file paths, R2 keys); actual files in R2
- **agent_runs** — Audit trail with token usage

**Important**: The `features.status` CHECK constraint and `artifacts` table schema must match what the application code expects. When adding new statuses, update the CHECK constraint via SQL in the Supabase SQL Editor. See `docs/SESSION-STATUS.md` for details on schema changes needed.

## Environment Variables

API (`api/.dev.vars`):
- `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `ALLOWED_ORIGIN`

Web (`web/.env`):
- `PUBLIC_SUPABASE_URL`, `PUBLIC_SUPABASE_ANON_KEY`, `PUBLIC_API_URL`

## Deployment

Automatic via GitHub Actions on push to main. API deploys to Cloudflare Workers, web builds and deploys to Cloudflare Pages. Push directly to main (no branch protection yet).

R2 bucket (`buildpractical-artifacts`) must exist in the Cloudflare account. The Cloudflare API token in GitHub Actions needs **Workers R2 Storage: Edit** permission.

## Auth Details

- Supabase Auth with email + password, email confirmation required
- JWKS URL: `https://blyljuoajecrzoyxomaj.supabase.co/auth/v1/.well-known/jwks.json`
- Frontend uses `@supabase/ssr` for cookie-based session management
- Auth guard on `/app/*` routes (see `web/src/routes/app/+layout.server.ts`)
- Download endpoint authenticates via `Authorization: Bearer` header (fetched as blob client-side)

## Vault Helper Functions (service-role only)

```sql
select public.store_user_secret(user_id, 'anthropic_key', 'sk-ant-...', 'Anthropic API key');
select public.read_user_secret(user_id, 'anthropic_key');
select public.delete_user_secret(user_id, 'anthropic_key');
select public.check_user_secret_exists(user_id, 'anthropic_key');
```
