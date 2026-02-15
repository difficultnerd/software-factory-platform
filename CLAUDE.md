# CLAUDE.md

## Project Overview

Build Practical (buildpractical.com) is a multi-tenant AI-powered software platform. Non-technical users describe software in conversation with a BA agent, and a pipeline of six constrained AI agents builds it.

## Live URLs

- Frontend: https://app.buildpractical.com (SvelteKit, Cloudflare Pages)
- API: https://api.buildpractical.com (Hono, Cloudflare Workers)
- Database: Supabase (https://blyljuoajecrzoyxomaj.supabase.co)

## Tech Stack

- API: Cloudflare Workers, Hono, TypeScript strict mode, Zod validation
- Frontend: SvelteKit 5 (Svelte 5 runes syntax: $props, $state, $derived), Tailwind CSS, Cloudflare Pages
- Database: Supabase PostgreSQL with RLS on ALL tables (user_id = auth.uid())
- Auth: Supabase Auth, JWKS-based JWT verification (asymmetric, no shared secret)
- Secrets: Supabase Vault (encrypted at rest, service-role only via security definer functions)
- Storage: Cloudflare R2 for generated artifacts
- AI: Anthropic Claude Sonnet via user BYOK keys

## Monorepo Structure

- `api/` - Cloudflare Workers (Hono). Dev: `npm run dev:api`
- `web/` - SvelteKit on Cloudflare Pages. Dev: `npm run dev:web`
- `supabase/migrations/` - SQL migrations (run manually in Supabase SQL Editor)
- `docs/` - Architecture and governance documents
- `.github/workflows/ci.yml` - CI pipeline

## Key Conventions

- TypeScript strict mode, no `any`
- All user input validated with Zod schemas at API boundaries
- All database tables MUST have RLS policies
- User secrets stored in Supabase Vault via helper functions (store_user_secret, read_user_secret, delete_user_secret, check_user_secret_exists) - these are service-role only
- Middleware chain order: errors -> headers -> CORS -> auth -> routes
- Structured JSON logging via src/lib/logger.ts
- Australian English in UI copy
- No emojis in UI

## API Middleware Kernel

Files in api/src/middleware/ are the security trust root. Do NOT modify without explicit approval:
- errors.ts - Global error handler, generic error responses
- headers.ts - Security headers (HSTS, CSP, X-Frame-Options, etc.)
- auth.ts - JWKS JWT verification, extracts userId
- validation.ts - Zod schema validation for body and query params

## Auth Details

- Supabase Auth with email + password, email confirmation required
- New API key format: publishable key (sb_publishable_...) = anon key, secret key (sb_secret_...) = service role key
- JWKS URL: https://blyljuoajecrzoyxomaj.supabase.co/auth/v1/.well-known/jwks.json
- Frontend uses @supabase/ssr for cookie-based session management
- Auth guard on /app/* routes (see web/src/routes/app/+layout.server.ts)

## Database Tables (already applied)

- profiles: extends auth.users, auto-created via trigger
- features: pipeline state machine (drafting -> spec_generating -> ... -> done/failed)
- chat_messages: BA agent conversation history
- artifacts: generated code metadata (files in R2)
- agent_runs: audit trail with token usage

## Vault Helper Functions (service-role only)

```sql
select public.store_user_secret(user_id, 'anthropic_key', 'sk-ant-...', 'Anthropic API key');
select public.read_user_secret(user_id, 'anthropic_key');
select public.delete_user_secret(user_id, 'anthropic_key');
select public.check_user_secret_exists(user_id, 'anthropic_key');
```

## Three Output Modes

1. Components (Data + Views): Declarative app definitions, rendered by platform runtime
2. Workflows (Triggers + Actions + AI): Workflow definitions, executed by platform runtime
3. Full Code (Escape Hatch): TypeScript source code, download as zip

See docs/ARCHITECTURE.md for full details.

## Environment Variables

API (api/.dev.vars):
- SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY

Web (web/.env):
- PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY, PUBLIC_API_URL

## Build Commands

```bash
cd api && npx tsc --noEmit          # API typecheck
cd web && npx svelte-check          # Web typecheck
npm run dev:api                      # Local API dev server (port 8787)
npm run dev:web                      # Local web dev server (port 5173)
```

## Deployment

Automatic via GitHub Actions on merge to main. API deploys to Cloudflare Workers, web builds and deploys to Cloudflare Pages. Push directly to main (no branch protection yet).

## Current State

Session 1 complete: auth working, CI green, custom domains live, database schema applied, Vault functions deployed. Dashboard shows empty state. Settings page has placeholder for API key management.

## What Needs Building Next

### Session 2a: API Key Settings
- API endpoint: POST/DELETE /api/settings/api-key (store/delete via Vault RPC using service client)
- API endpoint: GET /api/settings/api-key (check exists, return last 4 chars hint)
- Settings page: form to paste key, display hint, delete button
- Key stored as Vault secret named "{user_id}/anthropic_key"

### Session 2b: BA Agent Chat
- BA agent system prompt (knows platform capabilities, three modes, asks clarifying questions, produces structured brief)
- API endpoint: POST /api/chat/message (streaming response using user's BYOK key)
- API endpoint: GET /api/chat/:featureId (conversation history)
- Chat UI: message bubbles, streaming text display, send box
- Feature creation flow: user confirms brief -> feature created with status "spec_generating"

### Session 2c: Pipeline Orchestration
- Agent runner service (accepts agent name, tenant context, user's API key from Vault)
- Port agent logic from github.com/difficultnerd/software-factory-template/.github/scripts/
- State machine transitions triggered by agent completion and user approvals
- Status polling endpoint and frontend polling
- Approve/reject UI at each pipeline stage

### Session 2d: Code Output
- R2 storage for generated artifacts
- Download as zip endpoint
- Feature list page with status badges
- Feature detail page (rendered markdown for spec/plan, download button)
