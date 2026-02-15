# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Build Practical (buildpractical.com) is a multi-tenant AI-powered software platform. Non-technical users describe software in conversation with a BA agent, and a pipeline of constrained AI agents builds it: BA chat -> spec -> plan -> tests -> code generation (tool use) -> security review + code review -> download as zip.

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

There are no automated tests. Verification is typecheck-only.

## Monorepo Structure

- `api/` — Cloudflare Workers (Hono). Entry point: `src/index.ts`
- `web/` — SvelteKit on Cloudflare Pages
- `supabase/migrations/` — SQL migrations (run manually in Supabase SQL Editor)
- `docs/` — Architecture and governance documents
- `.github/workflows/ci.yml` — CI pipeline (typecheck + deploy)

## Key Conventions

- TypeScript strict mode, no `any`
- All user input validated with Zod schemas at API boundaries
- All database tables MUST have RLS policies
- User secrets stored in Supabase Vault via helper functions (`store_user_secret`, `read_user_secret`, `delete_user_secret`, `check_user_secret_exists`) — service-role only
- Middleware chain order: errors -> headers -> CORS -> auth -> routes
- Structured JSON logging via `api/src/lib/logger.ts`
- Australian English in UI copy (e.g. "colour", "organisation", "behaviour")
- No emojis in UI
- Supabase client patterns: authenticated client for user-scoped queries (RLS), service client for admin operations
- Always destructure `{ error }` from Supabase operations and handle failures — silent failures cause stuck features

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
tests_generating -> tests_ready -> (user approves) ->
implementing -> review -> done / failed
```

At each `*_ready` gate, an alignment reviewer runs automatically and produces an APPROVE/REVISE recommendation displayed to the user. Users can approve regardless of the recommendation.

Each agent phase follows the same pattern (see `api/src/routes/features.ts`):
1. Read user's API key from Vault via service client RPC
2. Call `runAgent()` with the agent's system/user prompts
3. On success: run alignment reviewer (non-critical), store output + recommendation, transition to next status
4. On failure: set status to `failed` with error message
5. Always check `{ error }` from Supabase updates — if save fails, transition to `failed`

### Agent Prompts (`api/src/lib/agents/`)

- `governance.ts` — Shared platform context and compliance standards (OWASP ASVS L2, Australian ISM) injected into all prompts
- `spec-prompt.ts` — Specification agent
- `plan-prompt.ts` — Planner agent
- `test-prompt.ts` — Contract test agent
- `code-prompt.ts` + `code-runner.ts` — Implementer agent (tool-use with `write_files` tool, Zod validation, retry loop, truncation salvage)
- `security-review-prompt.ts` — Security review (OWASP ASVS L2 + ISM checklist, outputs `VERDICT: PASS/FAIL`)
- `code-review-prompt.ts` — Code review (outputs `VERDICT: PASS/FAIL`)
- `alignment-review-prompt.ts` — Alignment reviewer (outputs `VERDICT: APPROVE/REVISE`)
- `runner.ts` — Generic agent runner (calls Anthropic, logs `agent_runs`)

### Recovery Mechanisms

- **Retry** (`POST /api/features/:id/retry`): When status is `failed`, determines last successful checkpoint and rolls back to it
- **Revise** (`POST /api/features/:id/revise`): At any `*_ready` gate, accepts a revised brief, clears all downstream deliverables and artifacts, restarts from `spec_generating`
- **Chat at gates**: BA chat is allowed at `drafting`, `spec_ready`, `plan_ready`, `tests_ready` — BA prompt is augmented with pipeline context at approval gates
- **Stuck recovery** (`api/src/lib/stuck-recovery.ts`): Scheduled worker runs every 15 min, auto-fails features stuck in processing states for >10 min

### Known Architectural Debt

Agents run **inline in HTTP request handlers**. The Anthropic streaming wrapper avoids Cloudflare 524 timeouts, but the pattern is fragile — the stuck-recovery cron is a safety net. Future improvement: move to Cloudflare Queues.

## API Routes

- `api/src/routes/settings.ts` — API key management (Vault CRUD)
- `api/src/routes/chat.ts` — BA agent chat (SSE streaming), conversation history
- `api/src/routes/features.ts` — Feature lifecycle: list, detail, delete, rename, confirm brief, approve spec/plan/tests, revise, retry, download zip

## Frontend Key Pages

- `web/src/routes/app/+page.svelte` — Dashboard (feature list with status badges, inline title editing)
- `web/src/routes/app/features/+page.svelte` — Chat interface for BA agent (also handles revise brief flow)
- `web/src/routes/app/features/[id]/+page.svelte` — Feature detail (pipeline breadcrumb, recommendation banners, approve/retry/discuss buttons, markdown rendering, download)
- `web/src/routes/app/settings/+page.svelte` — API key management

## Database Schema

Defined in `supabase/migrations/`. Key tables:
- **profiles** — Extends `auth.users`, auto-created via trigger
- **features** — Pipeline state machine with status CHECK constraint, stores brief/spec/plan/tests markdown, recommendation fields, review markdown
- **chat_messages** — BA agent conversation history
- **artifacts** — Generated code file metadata (file paths, R2 keys); actual files in R2
- **agent_runs** — Audit trail with token usage

**Important**: The `features.status` CHECK constraint must match application code. When adding new statuses, update the CHECK constraint via SQL in the Supabase SQL Editor. Migrations are run manually — not via CLI.

## Environment Variables

API (`api/.dev.vars`):
- `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `ALLOWED_ORIGIN`

Web (`web/.env`):
- `PUBLIC_SUPABASE_URL`, `PUBLIC_SUPABASE_ANON_KEY`, `PUBLIC_API_URL`

## Deployment

Automatic via GitHub Actions on push to main. API deploys to Cloudflare Workers (with R2 binding and cron trigger), web deploys to Cloudflare Pages. Push directly to main (no branch protection yet).

R2 bucket (`buildpractical-artifacts`) must exist in the Cloudflare account. The Cloudflare API token needs **Workers R2 Storage: Edit** permission.

## Auth Details

- Supabase Auth with email + password, email confirmation required
- JWKS URL: `https://blyljuoajecrzoyxomaj.supabase.co/auth/v1/.well-known/jwks.json`
- Frontend uses `@supabase/ssr` for cookie-based session management
- Auth guard on `/app/*` routes (see `web/src/routes/app/+layout.server.ts`)
- Download endpoint authenticates via `Authorization: Bearer` header (fetched as blob client-side)

## Compliance Standards

Generated code is reviewed against:
- **OWASP ASVS Level 2** — V2-V8, V13, V14 categories
- **Australian ISM** — Key controls: ISM-0974, ISM-1139, ISM-1235, ISM-0988, ISM-1401, ISM-0270, ISM-0459, ISM-0585, ISM-0120

These are referenced in `governance.ts` (injected into all agents), `security-review-prompt.ts` (detailed checklist), `spec-prompt.ts` (security requirements section), and `test-prompt.ts` (security test cases).

## Vault Helper Functions (service-role only)

```sql
select public.store_user_secret(user_id, 'anthropic_key', 'sk-ant-...', 'Anthropic API key');
select public.read_user_secret(user_id, 'anthropic_key');
select public.delete_user_secret(user_id, 'anthropic_key');
select public.check_user_secret_exists(user_id, 'anthropic_key');
```
