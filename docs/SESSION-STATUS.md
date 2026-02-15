# Session Status — 15 Feb 2026

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
- State machine: `drafting -> spec_generating -> spec_ready -> plan_generating -> plan_ready -> plan_approved`
- Status polling (3s interval) on detail page during `_generating` states
- Approve spec / approve plan UI on feature detail page
- Streaming internally to avoid Cloudflare 524 timeouts

### Post-2c Polish (just shipped)
- DELETE `/api/features/:id` — cascade deletes chat_messages, agent_runs, artifacts
- PATCH `/api/features/:id` — rename feature title (Zod validated, max 200 chars)
- AI-generated title after spec agent completes (quick 50-token summarisation call)
- Dashboard: inline title editing (Enter to save, Escape to cancel) + delete with confirmation
- Feature detail page: delete button in header with confirmation, redirects to dashboard

## Next Up: Session 2d — Code Output

### What needs building
1. **R2 storage integration** — configure Cloudflare R2 bucket binding in `wrangler.toml`
2. **Code generation agent(s)** — port remaining agents from `github.com/difficultnerd/software-factory-template/.github/scripts/`
3. **Artifact storage** — save generated files to R2, record metadata in `artifacts` table
4. **Download as zip endpoint** — `GET /api/features/:id/download` — stream zip from R2 artifacts
5. **Feature detail page** — render spec/plan markdown properly (currently `whitespace-pre-wrap` plain text), add download button when artifacts exist
6. **Status badges on feature list** — already partially done (status labels + colours exist)

### Key files likely involved
- `api/wrangler.toml` — add R2 bucket binding
- `api/src/types.ts` — add R2 binding to `Bindings` interface
- `api/src/routes/features.ts` — add download endpoint, wire up code gen agents
- `api/src/lib/agents/` — new agent prompts (code, test, security review)
- `web/src/routes/app/features/[id]/+page.svelte` — markdown rendering, download button

### Decisions to make
- Which code gen agents to port first (all 4 remaining, or just the code agent?)
- Markdown rendering library for spec/plan display (e.g. `marked`, `mdsvex`, or keep plain text)
- Zip generation approach (stream from R2 on-the-fly vs pre-build)

## Architecture Reference

- **API**: Cloudflare Workers + Hono, TypeScript strict, Zod validation
- **Web**: SvelteKit 5 (Svelte 5 runes: `$props`, `$state`, `$derived`), Tailwind CSS, Cloudflare Pages
- **DB**: Supabase PostgreSQL, RLS on all tables
- **Auth**: Supabase Auth, JWKS JWT, `@supabase/ssr` cookies
- **Secrets**: Supabase Vault (service-role only helper functions)
- **AI**: Anthropic Claude Sonnet via user BYOK keys
- **Deploy**: GitHub Actions on push to `main`, auto-deploys both API and web
