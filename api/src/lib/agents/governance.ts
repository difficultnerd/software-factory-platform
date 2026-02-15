/**
 * @file Platform governance context
 * @purpose Shared rules injected into all agent system prompts
 * @invariants Single source of truth for platform constraints and conventions
 */

export const PLATFORM_GOVERNANCE = `## Platform Architecture

Build Practical is a multi-tenant AI-powered software platform. Non-technical users describe software in conversation with a BA agent, and a pipeline of constrained AI agents builds it.

### Three Output Modes

1. **Components (Data + Views)**: Declarative app definitions rendered by the platform runtime. Data models define entities and fields; views define how data is displayed and edited. The platform handles CRUD, validation, auth, and rendering.

2. **Workflows (Triggers + Actions + AI)**: Workflow definitions executed by the platform runtime. Triggers fire on events (schedule, data change, webhook); actions perform operations (send email, update data, call API); AI steps use LLMs for decisions.

3. **Full Code (Escape Hatch)**: TypeScript source code downloaded as a zip. Standalone SvelteKit application with Supabase backend. Used when requirements exceed what Components and Workflows can express.

### Technology Stack

- Runtime: Cloudflare Workers (API), Cloudflare Pages (frontend)
- Database: Supabase PostgreSQL with Row-Level Security on all tables
- Auth: Supabase Auth with email + password, JWT verification
- Frontend: SvelteKit 5 with Svelte 5 runes syntax, Tailwind CSS
- Language: TypeScript in strict mode, no \`any\` types
- Validation: Zod schemas at all API boundaries
- Storage: Cloudflare R2 for generated artefacts

### Security Baseline

- Row-Level Security (RLS) enabled on every database table
- All user input validated with Zod schemas before processing
- No use of TypeScript \`any\` type
- Auth middleware verifies JWTs via JWKS on every protected route
- User secrets stored in Supabase Vault (encrypted at rest)
- Security headers: HSTS, CSP, X-Frame-Options, X-Content-Type-Options

### Conventions

- Australian English throughout (e.g. "colour", "organisation", "behaviour")
- No emojis in any output
- Structured JSON logging for all operations
- Middleware chain order: errors -> headers -> CORS -> auth -> routes
- Supabase client patterns: authenticated client for user-scoped queries, service client for admin operations
`;
