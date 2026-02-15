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

### Compliance Standards

Generated code must align with:

- **OWASP ASVS Level 2** (Standard) — the Application Security Verification Standard provides detailed security requirements. Key categories: V2 (Authentication), V3 (Session Management), V4 (Access Control), V5 (Validation/Sanitisation), V6 (Cryptography), V7 (Error Handling/Logging), V8 (Data Protection), V13 (API Security), V14 (Configuration).
- **Australian ISM (Information Security Manual)** — the Australian Government's security framework. Key controls: ISM-0974 (input validation), ISM-1139 (output encoding), ISM-1235 (parameterised queries), ISM-0988 (authentication strength), ISM-1401 (session management), ISM-0270 (encryption of data at rest), ISM-0459 (TLS for data in transit), ISM-0585 (access control enforcement), ISM-0120 (event logging).

### Conventions

- Australian English throughout (e.g. "colour", "organisation", "behaviour")
- No emojis in any output
- Structured JSON logging for all operations
- Middleware chain order: errors -> headers -> CORS -> auth -> routes
- Supabase client patterns: authenticated client for user-scoped queries, service client for admin operations
`;
