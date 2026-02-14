# Architecture: Build Practical

## Overview

Multi-tenant platform where non-technical users describe software features in conversation
with a BA agent, and a pipeline of six constrained AI agents builds it for them.

## Components

- **Frontend:** SvelteKit on Cloudflare Pages (app.buildpractical.com)
- **API:** Hono on Cloudflare Workers (api.buildpractical.com)
- **Database:** Supabase PostgreSQL with Row Level Security
- **Auth:** Supabase Auth (email + password, email confirmation, TOTP MFA planned)
- **Secrets:** Supabase Vault (encrypted at rest, service-role access only)
- **Code Storage:** Cloudflare R2
- **AI:** Anthropic Claude Sonnet via user BYOK keys

## Middleware Chain (API)

Order: errors -> headers -> CORS -> auth -> routes

Public paths: /health
Protected paths: /api/*

## Tenant Isolation

All tables enforce RLS with `user_id = auth.uid()`.
Vault secrets scoped by user ID prefix.
Agent runs use the requesting user's BYOK API key.

## Agent Pipeline

1. BA Agent (conversational, real-time)
2. Spec Agent (batch: brief -> spec)
3. Planner Agent (batch: spec -> plan)
4. Contract Test Agent (batch: spec + plan -> tests + schemas)
5. Implementer Agent (batch: spec + plan + tests -> code)
6. Security + Code Review Agents (batch: code -> findings)
