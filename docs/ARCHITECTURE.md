# Architecture: Build Practical

## Overview

Multi-tenant platform where non-technical users describe software in conversation
with a BA agent, and a pipeline of six constrained AI agents builds it for them.

The platform supports three output modes, selected automatically based on what the
user describes (or manually by the user).

## Output Modes

### Mode 1: Components (Data + Views)

For: CRUD apps, trackers, directories, dashboards, forms, lists.
Examples: Recipe tracker, bookmark manager, habit tracker, inventory, CRM-lite, event planner.

The pipeline produces a declarative **app definition** (JSON schema) that describes:
- Data tables: fields, types, relationships, constraints, file attachments
- Views: list, detail, form, card grid, kanban, calendar, chart
- Logic: validation rules, conditional visibility, computed fields, simple state machines
- Access: public, private, invite-only, role-based field visibility
- Automation: on-create/on-update triggers, simple notifications

The platform's **component runtime** interprets this schema and serves the app.
No arbitrary code executes. Cost is predictable (rows in our database, views from our frontend).

Published at: `app.buildpractical.com/u/{username}/{app-slug}`

### Mode 2: Workflows (Triggers + Actions + AI Logic)

For: Automations, integrations, scheduled tasks, AI-powered background agents.
Examples: Message-to-calendar sync, daily digest bot, Slack reminder agent, email auto-responder.

The pipeline produces a **workflow definition** that describes:
- Triggers: schedule (cron), webhook, message received, polling
- Actions: call API, send message, create/update record, store/retrieve data
- Connections: OAuth to third-party services (Google Calendar, Slack, email, etc.)
- AI steps: classify, extract, summarise, decide (Claude API call within the workflow)
- State: persistent key-value store for workflow context

The platform's **workflow runtime** executes these definitions.
Runtime: Cloudflare Workers (webhooks, API calls) + Cron Triggers (schedules) + Durable Objects (state).

Workflows run on our infrastructure but are sandboxed: they can only use
declared connections, cannot make arbitrary network calls, and are rate-limited.

### Mode 3: Full Code (Escape Hatch)

For: Anything that exceeds the constraints of modes 1 and 2.
Examples: Custom UIs, complex algorithms, novel integrations, performance-critical code.

The pipeline produces **source code** (TypeScript, SQL, config files) exactly
as the original software-factory-template did. Code is stored in R2 and available
for download as a zip.

Future: optional deployment to user's own infrastructure via connected cloud account
(Cloudflare, Vercel, AWS). This becomes a paid/pro feature.

Code never executes on our platform. We are a build tool, not a host, for this mode.

### Mode Selection

The BA agent recommends a mode based on the user's description:
- Mentions data, tracking, lists, forms -> Components
- Mentions scheduling, notifications, monitoring, syncing, "when X happens do Y" -> Workflow
- Mentions custom UI, algorithms, specific tech requirements -> Code
- User can override the recommendation

The spec agent's output format changes based on mode:
- Components: app definition schema (JSON)
- Workflow: workflow definition schema (JSON)
- Code: structured spec (markdown, as in factory-template)

The planner, contract test, and implementer agents adapt accordingly.
Security and code review agents review all three output types.

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
  +---> Supabase PostgreSQL (tenant data, app definitions, workflow definitions, feature state)
  +---> Supabase Vault (BYOK keys, user app secrets, connection tokens)
  +---> Cloudflare R2 (generated code artifacts, large outputs)
  +---> Cloudflare Durable Objects (workflow state, rate limiting)
  +---> Cloudflare Cron Triggers (scheduled workflows)
  +---> Anthropic API (via user's BYOK key)
  +---> GitHub API (optional, user's repo)
  +---> Third-party APIs (via user's connected OAuth tokens, for workflows)
```

### Frontend: SvelteKit on Cloudflare Pages

Pages:
- `/` - Landing page
- `/login`, `/signup` - Authentication
- `/app` - Dashboard (feature list, status)
- `/app/chat` - BA agent conversation
- `/app/features/:id` - Feature detail (spec, plan, code, status, approve/reject)
- `/app/settings` - API key, GitHub connection, OAuth connections
- `/u/:username/:app` - Published component apps (public runtime)

### API: Cloudflare Workers (Hono)

Middleware chain: errors -> headers -> CORS -> auth -> routes
Public paths: /health, /u/* (published apps, with their own access control)
Protected paths: /api/*

### Database: Supabase PostgreSQL

All tables enforce RLS with `user_id = auth.uid()`.

Core tables:
- `profiles` - extends auth.users
- `features` - pipeline state machine (drafting -> done/failed)
- `chat_messages` - BA agent conversation history
- `artifacts` - generated code/definitions (metadata, content in R2)
- `agent_runs` - audit trail, token usage tracking

Component mode tables:
- `app_definitions` - published app schemas
- `app_data` - rows for user-built component apps (polymorphic, schema-driven)
- `app_access` - public/private/invite-only, invited user list

Workflow mode tables:
- `workflow_definitions` - published workflow schemas
- `workflow_runs` - execution log
- `workflow_state` - persistent KV state per workflow
- `connections` - OAuth tokens for third-party services (stored in Vault)

### Secrets: Supabase Vault

All sensitive user data encrypted at rest via Vault:
- BYOK Anthropic API keys
- OAuth tokens for connected services (Google, Slack, etc.)
- Any secrets defined within user workflows
- Access restricted to service_role via security definer functions

### Code/Artifact Storage: Cloudflare R2

- `/{user_id}/{feature_id}/` - generated artifacts per feature
- `/{user_id}/apps/{app_id}/` - published app definitions
- `/{user_id}/workflows/{workflow_id}/` - published workflow definitions

### Workflow Runtime

- **Webhook receiver**: Workers route that accepts inbound webhooks, matches to workflow, executes
- **Scheduler**: Cron Triggers for time-based workflows
- **Executor**: Workers function that interprets workflow definition steps sequentially
- **State**: Durable Objects for workflow instance state (survives across executions)
- **Connections**: OAuth token refresh and API call proxy (tokens from Vault)

Workflows are sandboxed:
- Can only call APIs via declared connections (no arbitrary fetch)
- Rate limited per user (executions per hour)
- Timeout per execution (30 seconds for free tier)
- AI steps use the user's BYOK key

## Tenant Isolation

- All database tables enforce RLS with `user_id = auth.uid()`
- Vault secrets scoped by user ID prefix
- Agent runs use the requesting user's BYOK API key
- Published component apps scope end-user data by `app_id` + `end_user_id`
- Workflow executions scoped by `user_id` + `workflow_id`
- R2 keys prefixed by user ID

## End Users of Published Apps

Three-tier user model:
1. **Platform owner** (you) - full admin
2. **Builders** - sign up, use BA agent, build and publish features
3. **End users** - use published component apps, no platform account required for public apps

End user auth (for invite-only or private apps):
- Simple email + magic link (no password)
- Scoped to the specific app, not a platform-wide account
- Builder manages their own app's user list

## Access Control for Published Apps

| Level | Who can access | Auth required |
|-------|---------------|---------------|
| Private | Builder only | Builder session |
| Invite-only | Builder + invited emails | Magic link |
| Public | Anyone with the URL | None |

## Rate Limiting

### Builder rate limits (platform usage)
- Agent calls: governed by BYOK key (their Anthropic bill)
- Features: 20 active features per user (free tier)
- Storage: 500MB R2 per user (free tier)

### Published app rate limits (end-user traffic)
- Component apps: 100 requests/min per app (free), 1000 (paid)
- Workflow executions: 100/hour per user (free), 1000 (paid)
- Workflow execution timeout: 30s (free), 120s (paid)
- Data rows per app: 10,000 (free), 100,000 (paid)
- Published apps per user: 3 (free), unlimited (paid)

Enforced at the Workers API layer. Cloudflare Durable Objects as rate limit counters.

## Cost Model

| Resource | Free Tier | Ceiling Before Paid |
|----------|-----------|-------------------|
| Cloudflare Workers | 100k req/day | ~500 active users |
| Cloudflare R2 | 10GB | ~100 users at 100MB each |
| Cloudflare Durable Objects | 1M req | ~10k workflow executions |
| Supabase Database | 500MB | ~200 active builders |
| Supabase Auth | 50k MAUs | Not a concern |
| Anthropic API | BYOK | Zero cost to platform |

First cost trigger is likely Supabase at ~200 active builders ($25/mo Pro plan).
Second is Cloudflare Workers if end-user traffic is high ($5/mo paid plan).

## Security Posture

- Middleware kernel (auth, headers, errors, validation) frozen after bootstrap
- JWKS-based JWT verification (asymmetric, no shared secret)
- RLS on all tables, no exceptions
- Supabase Vault for all user secrets
- BYOK keys never leave Workers runtime memory
- No arbitrary code execution on platform (modes 1 and 2)
- Mode 3 code never executes on platform
- All agent outputs reviewed by security reviewer agent
- Workflow sandboxing: declared connections only, rate limited, timeouts
- Published app access control: public/private/invite-only per app

## Agent Pipeline

Shared across all modes:
1. **BA Agent** (conversational, real-time) - helps define the feature, recommends mode
2. **Spec Agent** (batch) - produces mode-specific spec/definition
3. **Planner Agent** (batch) - decomposes into tasks
4. **Contract Test Agent** (batch) - generates validation tests for the definition/code
5. **Implementer Agent** (batch) - produces the final definition/code
6. **Security + Code Review Agents** (batch) - review output

Mode-specific behaviour:
- Components: implementer generates app definition JSON, tests validate schema
- Workflows: implementer generates workflow definition JSON, tests validate steps and connections
- Code: implementer generates TypeScript files, tests are Vitest/Zod (as in factory-template)
