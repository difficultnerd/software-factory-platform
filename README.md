# Build Practical

Describe software. We build it.

An AI-powered platform where you describe what you need in plain English,
and a team of specialised agents produce the spec, tests, and code.

## Development

```bash
# API (Cloudflare Workers)
npm run dev:api

# Web (SvelteKit)
npm run dev:web
```

## Deployment

Automatic on merge to main via GitHub Actions.

- API: Cloudflare Workers
- Web: Cloudflare Pages
- Database: Supabase
