# Architecture: Build Practical

## Overview

Multi-tenant platform where non-technical users describe software in conversation
with a BA agent, and a pipeline of constrained AI agents builds it for them.

The pipeline produces **source code** (TypeScript, SQL, config files) stored in
Cloudflare R2, available for download as a zip. Code never executes on the platform
-- we are a build tool, not a host.

## System Components

```
User (browser)
  |
  v
Cloudflare Pages (SvelteKit frontend)
  |
  v
Cloudflare Workers (API)
  |
  +---> Supabase Auth (signup, login, JWT)
  +---> Supabase PostgreSQL (tenant data, feature state)
  +---> Supabase Vault (BYOK keys via security definer functions)
  +---> Cloudflare R2 (generated code artifacts)
  +---> Cloudflare Queues (async agent pipeline execution)
  +---> Cloudflare Cron Triggers (stuck recovery, every 15 min)
  +---> Anthropic API (via user's BYOK key)
```

### Frontend: SvelteKit on Cloudflare Pages

Pages:
- `/` - Landing page
- `/login`, `/signup` - Authentication
- `/app` - Dashboard (feature list with status badges, inline title editing)
- `/app/features` - BA agent chat interface (also handles revise brief flow)
- `/app/features/:id` - Feature detail (pipeline breadcrumb, recommendation banners, approve/retry/discuss, markdown rendering, download)
- `/app/settings` - API key management

### API: Cloudflare Workers (Hono)

Middleware chain: errors -> headers -> CORS -> (public routes) -> auth -> (protected routes)

Public paths: `/health`
Protected paths: `/api/*`

Route files:
- `api/src/routes/settings.ts` - API key management (Vault CRUD)
- `api/src/routes/chat.ts` - BA agent chat (SSE streaming), conversation history
- `api/src/routes/features.ts` - Feature lifecycle: list, detail, delete, rename, confirm brief, approve spec/plan/tests, revise, retry, download zip

### Queue-Based Pipeline

Agent execution is fully asynchronous via Cloudflare Queues:
- Route handlers enqueue pipeline messages (e.g. `run_spec`, `run_plan`)
- Queue consumer (`api/src/lib/pipeline.ts`) processes steps one at a time
- Each step: read inputs from DB -> run agent -> save output -> enqueue next step
- Max batch size: 1, max retries: 2, dead letter queue: `pipeline-dlq`

This avoids Cloudflare 524 timeouts entirely. The stuck-recovery cron
(every 15 min) auto-fails features stuck in processing states for >10 minutes
as a safety net.

### Database: Supabase PostgreSQL

All tables enforce RLS with `user_id = auth.uid()`.

Tables:
- `profiles` - extends auth.users, auto-created via trigger
- `features` - pipeline state machine with status CHECK constraint, stores brief/spec/plan/tests/review markdown, recommendation fields
- `chat_messages` - BA agent conversation history
- `artifacts` - generated code file metadata (file paths, R2 keys); actual files in R2
- `agent_runs` - audit trail with token usage

### Secrets: Supabase Vault

All sensitive user data encrypted at rest via Vault:
- BYOK Anthropic API keys
- Access restricted to service_role via security definer functions

### Artifact Storage: Cloudflare R2

Bucket: `buildpractical-artifacts`
Key pattern: `/{user_id}/{feature_id}/` - generated artifacts per feature

## Tenant Isolation

- All database tables enforce RLS with `user_id = auth.uid()`
- Vault secrets scoped by user ID prefix
- Agent runs use the requesting user's BYOK API key
- R2 keys prefixed by user ID

## Agent Pipeline

The feature pipeline is a state machine managed in the `features` table:

```
drafting
  -> (user confirms brief)
spec_generating -> spec_ready
  -> (user approves spec)  -> spec_approved
plan_generating -> plan_ready
  -> (user approves plan)  -> plan_approved
tests_generating -> tests_ready
  -> (user approves tests) -> tests_approved
implementing -> review
  -> done / failed
```

At each `*_ready` gate, an alignment reviewer runs automatically and produces
an APPROVE/REVISE recommendation displayed to the user. Users can approve
regardless of the recommendation.

### Agents

| Agent | File(s) | Model | Max Tokens | Purpose |
|-------|---------|-------|------------|---------|
| BA | `ba-prompt.ts` | claude-sonnet-4-5 | streaming | Conversational, helps define feature |
| Spec | `spec-prompt.ts` | claude-sonnet-4-5 | 32,000 | Produces structured specification |
| Planner | `plan-prompt.ts` | claude-sonnet-4-5 | 32,000 | Decomposes spec into implementation tasks |
| Contract Test | `test-prompt.ts` | claude-sonnet-4-5 | 32,000 | Generates validation tests |
| Implementer | `code-prompt.ts` + `code-runner.ts` | claude-opus-4-6 | 128,000 | Tool-use code generation (write_files tool) |
| Security Review | `security-review-prompt.ts` | claude-sonnet-4-5 | 16,000 | OWASP ASVS L2 + ISM checklist, PASS/FAIL |
| Code Review | `code-review-prompt.ts` | claude-sonnet-4-5 | 16,000 | Quality review, PASS/FAIL |
| Alignment Review | `alignment-review-prompt.ts` | claude-haiku-4-5 | 500 | Gate reviewer, APPROVE/REVISE |
| Title | (inline) | claude-haiku-4-5 | 50 | Auto-generates feature title after spec |

Supporting files:
- `governance.ts` - shared platform context and compliance standards injected into all prompts
- `runner.ts` - generic agent runner (calls Anthropic API, logs `agent_runs`)
- `agent-config.ts` - model selection and token limits per agent type

### Queue Message Types

- `run_spec`, `run_plan`, `run_tests`, `run_implement`
- `run_security_review`, `run_code_review`, `run_verdict`

### Review Phase

After implementation completes, security review and code review run automatically.
The verdict step checks both verdicts: both must PASS to transition to `done`.
Either FAIL transitions to `failed` with explanation.

### Recovery Mechanisms

- **Retry** (`POST /api/features/:id/retry`): When status is `failed`, determines last successful checkpoint and rolls back to it
- **Revise** (`POST /api/features/:id/revise`): At any `*_ready` gate, accepts a revised brief, clears all downstream deliverables and artifacts, restarts from `spec_generating`
- **Chat at gates**: BA chat is allowed at `drafting`, `spec_ready`, `plan_ready`, `tests_ready` -- BA prompt is augmented with pipeline context at approval gates
- **Stuck recovery** (`api/src/lib/stuck-recovery.ts`): Cron every 15 min, auto-fails features stuck in processing states for >10 min

## Security Posture

- Middleware kernel (auth, headers, errors, validation) frozen after bootstrap
- JWKS-based JWT verification (asymmetric, no shared secret)
- RLS on all tables, no exceptions
- Supabase Vault for all user secrets
- BYOK keys never leave Workers runtime memory
- Generated code never executes on platform
- All agent outputs reviewed by security reviewer agent
- Compliance: OWASP ASVS Level 2, Australian ISM key controls

## Cost Model

| Resource | Free Tier | Ceiling Before Paid |
|----------|-----------|---------------------|
| Cloudflare Workers | 100k req/day | ~500 active users |
| Cloudflare R2 | 10GB | ~100 users at 100MB each |
| Cloudflare Queues | 1M messages/mo | ~10k pipeline runs |
| Supabase Database | 500MB | ~200 active builders |
| Supabase Auth | 50k MAUs | Not a concern |
| Anthropic API | BYOK | Zero cost to platform |

First cost trigger is likely Supabase at ~200 active builders ($25/mo Pro plan).

## Future Roadmap

The platform is designed to support additional output modes beyond source code:

- **Components mode**: Declarative app definitions (JSON schema) interpreted by a component runtime, for CRUD apps and dashboards
- **Workflows mode**: Workflow definitions for automations and integrations, executed by a workflow runtime on Cloudflare Workers + Durable Objects

These modes are not yet implemented. The current pipeline handles Full Code mode only.
