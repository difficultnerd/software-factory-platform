# Session Status — 16 Feb 2026

## Completed

### Session 1: Foundation
- Auth (Supabase Auth, JWKS JWT verification, cookie-based sessions)
- CI/CD green (GitHub Actions -> Cloudflare Workers + Pages)
- Custom domains live (app.buildpractical.com, api.buildpractical.com)
- Database schema applied (profiles, features, chat_messages, artifacts, agent_runs)
- Vault functions deployed (store/read/delete/check user secrets)

### Session 2a: API Key Settings
- POST/DELETE/GET `/api/settings/api-key` (Vault RPC via service client)
- Settings page UI: paste key, display last-4 hint, delete button

### Session 2b: BA Agent Chat
- BA agent system prompt (platform-aware, asks clarifying questions, produces structured brief)
- POST `/api/chat/message` (streaming response using user's BYOK Anthropic key)
- GET `/api/chat/:featureId` (conversation history)
- Chat UI: message bubbles, streaming text, send box
- Feature creation flow: user confirms brief -> status transitions to `spec_generating`

### Session 2c: Pipeline Orchestration
- Agent runner service (`api/src/lib/agents/runner.ts`) — calls Anthropic, logs `agent_runs`
- Spec agent + plan agent with constrained prompts
- State machine: full 14-status pipeline from `drafting` through `done`/`failed`
- Status polling on detail page during `_generating` states
- Approve spec / approve plan / approve tests UI on feature detail page
- Streaming internally to avoid Cloudflare 524 timeouts

### Session 2d: Code Output + Reviews
- R2 storage integration — `ARTIFACTS` binding in `wrangler.toml`
- Contract test agent (`test-prompt.ts`)
- Implementer agent (`code-prompt.ts` + `code-runner.ts`) — tool-use with `write_files`, Zod validation, retry loop, truncation salvage
- Security review agent (`security-review-prompt.ts`) — OWASP ASVS L2 + ISM checklist
- Code review agent (`code-review-prompt.ts`)
- Alignment review agent (`alignment-review-prompt.ts`) — APPROVE/REVISE at each gate
- Agent config (`agent-config.ts`) — model selection per agent type
- Artifact storage in R2, metadata in `artifacts` table
- Download as zip endpoint (`GET /api/features/:id/download`) using `fflate`
- Feature detail page: markdown rendering via `marked`, download button, recommendation banners
- Verdict step: both security + code review must PASS to reach `done`

### Session 2e: Queue Migration + Reliability
- Migrated agent execution from inline HTTP handlers to Cloudflare Queues
- Queue producer/consumer pattern (`PIPELINE_QUEUE` binding, `pipeline.ts` consumer)
- Dead letter queue (`pipeline-dlq`) for failed messages
- Direct Anthropic API HTTP wrapper (`anthropic.ts`) — no SDK dependency
- Agent truncation handling and salvage improvements
- Stuck recovery cron (every 15 min) as safety net

### Post-Session Polish
- DELETE `/api/features/:id` — cascade deletes chat_messages, agent_runs, artifacts
- PATCH `/api/features/:id` — rename feature title (Zod validated, max 200 chars)
- AI-generated title after spec agent completes (quick 50-token summarisation call)
- Dashboard: inline title editing (Enter to save, Escape to cancel) + delete with confirmation
- Feature detail page: delete button in header with confirmation, redirects to dashboard
- Retry endpoint (`POST /api/features/:id/retry`) — rolls back to last checkpoint
- Revise endpoint (`POST /api/features/:id/revise`) — clears downstream, restarts from spec
- BA chat at approval gates — prompt augmented with pipeline context

## Current State

The full pipeline is operational end-to-end: users can describe software, approve spec/plan/tests at each gate, generate code via tool-use, receive automated security + code reviews, and download the result as a zip.

## Architecture Reference

- **API**: Cloudflare Workers + Hono, TypeScript strict, Zod validation
- **Web**: SvelteKit 5 (Svelte 5 runes: `$props`, `$state`, `$derived`), Tailwind CSS, Cloudflare Pages
- **DB**: Supabase PostgreSQL, RLS on all tables
- **Auth**: Supabase Auth, JWKS JWT, `@supabase/ssr` cookies
- **Secrets**: Supabase Vault (service-role only helper functions)
- **AI**: Anthropic Claude (Sonnet 4.5 for most agents, Opus 4.6 for implementer, Haiku 4.5 for lightweight tasks) via user BYOK keys
- **Pipeline**: Cloudflare Queues (async), stuck-recovery cron (every 15 min)
- **Storage**: Cloudflare R2 (`buildpractical-artifacts` bucket)
- **Deploy**: GitHub Actions on push to `main`, auto-deploys both API and web
