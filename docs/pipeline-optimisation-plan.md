# Pipeline Optimisation Plan

**Date**: 2026-02-16
**Status**: Draft for review

This document addresses six issues identified in the Build Practical pipeline and proposes concrete changes grouped into implementable work packages.

---

## Current State Summary

The pipeline runs: `spec → plan → tests → implement → security_review → code_review → verdict → done/failed`. Reviews use binary PASS/FAIL verdicts. On failure, the user must manually retry (which re-runs the implementer without feeding back what went wrong). The implementer uses Opus at 128K tokens (most expensive step). Reviews use Sonnet at 16K tokens — if the code exceeds that budget, the review truncates and auto-fails. No static analysis tools are used; all quality checks are AI-only.

---

## Work Package 1: Auto-Fix Loop (Issues 1, 3)

**Problem**: When security or code review fails, the pipeline goes to `failed`. The user retries, which re-runs the implementer from scratch without the review findings. The implementer repeats the same mistakes.

**Solution**: Add a `fixing` state and a `run_fix` pipeline step between verdict and `done`/`failed`. When reviews fail with fixable issues, feed the findings back to the implementer for a targeted fix attempt.

### Changes

**A. New pipeline state: `fixing`**

Update the `features.status` CHECK constraint (SQL migration):
```
'drafting','spec_generating','spec_ready','spec_approved',
'plan_generating','plan_ready','plan_approved',
'tests_generating','tests_ready','tests_approved',
'implementing','review','fixing','done','failed'
```

**B. New pipeline message type: `run_fix`**

Add to `PipelineMessage.type` in `pipeline.ts`:
```typescript
type: '...' | 'run_fix';
```

**C. Modify `stepRunVerdict` in `pipeline.ts`**

Current: if either review fails → set `failed`.
New logic:
```
if both PASS → done
else if fix_attempts < MAX_FIX_ATTEMPTS (1):
  → set status = 'fixing'
  → increment fix_attempts column
  → enqueue 'run_fix' with review findings
else:
  → set status = 'failed' (with review reports preserved)
```

This gives one auto-fix attempt before failing. The user can still manually retry after that.

**D. New `stepRunFix` function in `pipeline.ts`**

1. Read both review markdowns from the features table
2. Read current artifacts from R2
3. Extract Critical/High findings from both reviews (parse the markdown)
4. Call the implementer with a **fix prompt** (not the full generation prompt):
   - System: "You are a code fixer. You receive existing code files and review findings. Output ONLY the corrected files using the write_files tool."
   - User: the current files + the specific findings to fix
5. Upload corrected files to R2 (replace existing artifacts)
6. Re-run security and code review on the corrected files
7. Re-run verdict

**E. New agent prompt: `fix-prompt.ts`**

A focused prompt that includes:
- The current code files (from R2)
- The specific Critical/High findings extracted from reviews
- Instructions to fix ONLY the identified issues, not rewrite everything
- Same tool use interface (`write_files`) as the implementer

This is cheaper than a full re-implementation because:
- The fix prompt includes existing code (the model edits rather than generates from scratch)
- The fix prompt is scoped to specific issues (not "implement the whole spec")
- Can use Sonnet instead of Opus for fixes (targeted changes, not creative generation)

**F. Add `fix_attempts` column to `features` table**

```sql
ALTER TABLE features ADD COLUMN fix_attempts integer NOT NULL DEFAULT 0;
```

**G. Update retry endpoint in `features.ts`**

When retrying from `failed`, reset `fix_attempts` to 0 so the user gets a fresh fix budget.

### Frontend Changes

- Add `fixing` to `isProcessing()` check in `[id]/+page.svelte` so polling continues
- Add a "Fixing review issues..." status message in the pipeline breadcrumb
- Show the review findings in the UI even during fixing (so users can see what's being fixed)

### Token Cost

- Fix attempts use Sonnet (not Opus) with existing code as context
- Estimated cost per fix: ~60% of original review cost, ~20% of original implementation cost
- Net saving: avoids a full re-implementation retry, which costs 100% of the original

---

## Work Package 2: Faster UI Updates (Issue 2)

**Problem**: The UI polls every 3 seconds. There are no artificial delays, but 3 seconds is noticeable when agents complete quickly (e.g. alignment review at 500 tokens).

**Solution**: Replace polling with Supabase Realtime subscriptions for instant push updates. Fall back to 3-second polling if the subscription fails.

### Changes

**A. Add Supabase Realtime subscription in `[id]/+page.svelte`**

```typescript
// Subscribe to changes on this specific feature row
const channel = supabase
  .channel(`feature-${feature.id}`)
  .on('postgres_changes', {
    event: 'UPDATE',
    schema: 'public',
    table: 'features',
    filter: `id=eq.${feature.id}`,
  }, (payload) => {
    // Update local state immediately
    feature = payload.new;
  })
  .subscribe();
```

**B. Keep 3-second polling as fallback**

Realtime subscriptions can drop. Keep the existing polling loop but only activate it if the Realtime subscription fails to connect within 5 seconds.

**C. Enable Realtime on the `features` table**

This requires enabling Realtime in the Supabase dashboard for the `features` table. RLS policies already exist, so users will only receive updates for their own features.

**D. Dashboard updates**

Add a Realtime subscription on the dashboard (`+page.svelte`) that listens for any status changes across the user's features. This eliminates the current "load once" behaviour and shows live status updates.

### No Backend Changes Required

Supabase Realtime is a Supabase-hosted feature; no API changes needed.

---

## Work Package 3: Static Analysis Pre-Filter (Issue 6)

**Problem**: All quality checks are AI-based, burning tokens on issues that can be caught deterministically. AI reviews have a 16K token budget; large codebases truncate and auto-fail.

**Solution**: Add a static analysis step before AI reviews. Catch mechanical issues deterministically (zero token cost) and only use AI for semantic/architectural review.

### Approach: In-Worker Static Analysis

Since the code exists as strings in memory (read from R2), run analysis functions directly in the Worker without needing external tools. These are pattern-matching functions, not full compilers.

### Changes

**A. New file: `api/src/lib/static-analysis.ts`**

A set of pure functions that analyse code strings and return findings:

```typescript
interface StaticFinding {
  severity: 'critical' | 'high' | 'medium' | 'low';
  file: string;
  line?: number;
  rule: string;
  message: string;
}

function runStaticAnalysis(files: Array<{path: string; content: string}>): StaticFinding[]
```

**Checks to implement (zero AI cost):**

1. **TypeScript `any` detection**: Regex for `: any`, `as any`, `<any>` patterns → High severity
2. **TODO/FIXME detection**: Regex for `TODO`, `FIXME`, `HACK`, `XXX` → High severity
3. **Hardcoded secrets**: Regex for patterns like `sk-ant-`, `password = "`, `apiKey = "`, `Bearer ` in string literals → Critical severity
4. **eval() usage**: Detect `eval(`, `new Function(` → Critical severity
5. **innerHTML usage**: Detect `.innerHTML =`, `dangerouslySetInnerHTML` → High severity
6. **Console.log in production code**: Detect `console.log`, `console.debug` → Low severity
7. **Empty catch blocks**: Detect `catch {` or `catch (e) {` followed by `}` with nothing between → Medium severity
8. **SQL string concatenation**: Detect patterns like `` `SELECT * FROM ${` `` or `"SELECT" +` → Critical severity
9. **Missing Zod validation**: For API route files, check that `z.` appears (heuristic) → Medium severity
10. **File path validation**: Ensure no `../` traversal in file paths → Critical severity

**B. Integrate into pipeline before AI reviews**

In `stepRunImplement` (after uploading files to R2, before enqueueing security review):

```typescript
const staticFindings = runStaticAnalysis(codeResult.files);
const criticalOrHigh = staticFindings.filter(f =>
  f.severity === 'critical' || f.severity === 'high'
);

if (criticalOrHigh.length > 0) {
  // Don't waste tokens on AI review — auto-fix first
  // Save static findings as a pseudo-review
  await serviceClient.from('features').update({
    status: 'fixing',
    static_analysis_markdown: formatStaticFindings(staticFindings),
  }).eq('id', featureId);
  await env.PIPELINE_QUEUE.send({ type: 'run_fix', featureId, userId });
  return;
}
```

This means: if static analysis catches Critical/High issues, skip the AI reviews entirely and go straight to fixing. This saves the cost of two Sonnet calls (security + code review) when the code has obvious mechanical problems.

**C. Pass static analysis results to AI reviews as context**

When static analysis passes (no Critical/High), include the Low/Medium findings in the AI review prompt as "already identified" items. This lets the AI focus on semantic issues rather than re-discovering mechanical ones.

**D. Add `static_analysis_markdown` column**

```sql
ALTER TABLE features ADD COLUMN static_analysis_markdown text;
```

### Cost Saving Estimate

Based on common failure patterns:
- ~30% of review failures are mechanical (any types, TODOs, missing validation)
- Each skipped AI review saves ~16K output tokens of Sonnet cost
- Net saving: ~30% reduction in review-related token spend

---

## Work Package 4: Token Cost Optimisation (Issue 4)

**Problem**: The pipeline burns tokens on repeated governance context, oversized review inputs, and uses Opus uniformly regardless of feature complexity.

### Changes

**A. Prompt Caching**

Anthropic's prompt caching (via `cache_control` blocks) caches the system prompt and reused prefixes. The governance context (~2K tokens) is identical across all agent calls for a pipeline run.

Modify `anthropic.ts` to support the caching beta header and mark system prompts with `cache_control`:

```typescript
// In streamChatCompletion and callToolCompletion:
headers['anthropic-beta'] = 'prompt-caching-2024-07-31,output-128k-2025-02-19';

// System prompt as structured block:
system: [
  { type: 'text', text: governanceContext, cache_control: { type: 'ephemeral' } },
  { type: 'text', text: agentSpecificPrompt },
]
```

**Saving**: ~90% reduction on the governance prefix for subsequent calls within the same pipeline run (5-minute cache TTL, well within a single pipeline execution).

**B. Complexity-Based Model Selection**

Add a complexity scoring function that analyses the spec to determine feature complexity:

```typescript
function estimateComplexity(specMarkdown: string): 'simple' | 'moderate' | 'complex' {
  const entityCount = (specMarkdown.match(/###\s/g) || []).length;
  const wordCount = specMarkdown.split(/\s+/).length;

  if (entityCount <= 3 && wordCount < 1000) return 'simple';
  if (entityCount <= 8 && wordCount < 3000) return 'moderate';
  return 'complex';
}
```

Model selection:
- **Simple**: Use Sonnet for implementation (saves ~75% vs Opus)
- **Moderate**: Use Sonnet with extended thinking (good balance)
- **Complex**: Use Opus (current behaviour)

Store the complexity rating in the features table so it's visible to the user and influences downstream steps.

**C. Increase Review Token Budgets**

Counterintuitively, increasing review budgets from 16K to 32K **saves** money overall. Currently, reviews that truncate at 16K auto-fail and trigger a full retry (costing another Opus implementation + two reviews). With 32K, reviews complete successfully more often, avoiding the retry entirely.

Update `agent-config.ts`:
```typescript
security_review: { model: 'claude-sonnet-4-5-20250929', maxTokens: 32000 },
code_review:     { model: 'claude-sonnet-4-5-20250929', maxTokens: 32000 },
```

**D. Truncation-Aware Review Skipping**

If the implementer output was truncated (`wasTruncated: true`), skip AI reviews entirely. Truncated code is guaranteed to fail review (missing files). Instead, go straight to `failed` with a clear message:

```
"Code generation was truncated — some files are missing.
Please simplify the feature brief or break it into smaller features."
```

This saves two Sonnet review calls on code that will definitely fail.

**E. Compress Code for Reviews**

Before sending code to reviews, strip:
- Block comments (preserve single-line doc comments)
- Consecutive blank lines (collapse to single)
- Import statement grouping (collapse multiple imports to summary)

This reduces token count by ~15-25% without losing semantic content. Implement as a `compressForReview(files)` utility in `static-analysis.ts`.

### Combined Cost Saving Estimate

| Optimisation | Estimated Saving |
|---|---|
| Prompt caching | 5-10% overall (governance prefix) |
| Complexity-based model selection | 20-40% on simple features (majority) |
| Review budget increase (fewer retries) | 10-15% on features that currently truncate |
| Truncation-aware skip | 5-10% on truncated features |
| Code compression for reviews | 5-8% on review token input |
| **Combined** | **30-50% overall token cost reduction** |

---

## Work Package 5: Publish to Production (Issue 5)

**Problem**: Generated code is download-only. Users want to deploy their generated applications.

### Proposed Architecture: Cloudflare Pages Deployment

Since the platform already runs on Cloudflare, deploying user projects to Cloudflare Pages is the most natural path. Each user project gets its own Pages project.

### Phased Approach

**Phase 1: Static Preview Deployments**

The simplest starting point: deploy the generated frontend files to a Cloudflare Pages preview URL.

Flow:
1. User clicks "Publish" on a completed feature (`status: done`)
2. API reads artifacts from R2
3. API calls Cloudflare Pages Direct Upload API to create a deployment
4. Returns a preview URL (e.g. `https://{project-name}.pages.dev`)
5. Store the deployment URL in the features table

New column:
```sql
ALTER TABLE features ADD COLUMN deployment_url text;
ALTER TABLE features ADD COLUMN deployment_status text
  CHECK (deployment_status IN ('pending', 'deploying', 'deployed', 'failed'));
```

New API endpoint:
```
POST /api/features/:id/publish
```

This endpoint:
1. Verifies `status: done`
2. Reads artifacts from R2
3. Calls Cloudflare Pages API (using the platform's Cloudflare API token)
4. Creates/updates a Pages project named `bp-{user_id_prefix}-{feature_id_prefix}`
5. Returns the deployment URL

**Phase 2: Full-Stack Deployments**

For features that include API routes and database schemas:
1. Deploy frontend to Cloudflare Pages
2. Deploy API to a new Cloudflare Workers project
3. Run database migrations against a project-specific Supabase instance (or shared with schema isolation)

This phase requires more infrastructure:
- Supabase project provisioning API (or schema-per-tenant approach)
- Cloudflare Workers deployment API
- Environment variable management for deployed projects
- Custom domain support

**Phase 3: Custom Domains and Ongoing Management**

- Custom domain mapping via Cloudflare API
- Automatic SSL provisioning
- Deployment history and rollback
- Usage monitoring and billing

### Implementation Notes for Phase 1

Phase 1 is achievable with minimal infrastructure. The key dependency is a Cloudflare API token with Pages deployment permissions. The `@cloudflare/pages-shared` package or direct API calls to `https://api.cloudflare.com/client/v4/accounts/{account_id}/pages/projects` can handle deployment.

The platform's existing Cloudflare account would host all user projects. Subdomain isolation (`{project}.pages.dev`) provides reasonable separation for previews.

### Cost Considerations

- Cloudflare Pages free tier: 500 builds/month, unlimited bandwidth
- Each feature deployment counts as one build
- For scale: Cloudflare Pages Pro ($20/month) gives 5000 builds/month
- R2 egress is free (artifacts are already stored there)

---

## Work Package 6: Review Calibration (Issue 1)

**Problem**: Reviews are binary PASS/FAIL. The security review applies full OWASP ASVS L2 + ISM checklist to prototype code. Many features fail on Medium-severity issues that are flagged as High due to checklist interpretation.

### Changes

**A. Tiered Review Outcomes**

Modify the verdict system to support three outcomes instead of two:

```
VERDICT: PASS         — No issues or Low/Informational only
VERDICT: PASS_WITH_NOTES — Medium issues noted but not blocking
VERDICT: FAIL         — Critical or High issues present
```

Update `parseVerdict` in `pipeline.ts`:
```typescript
function parseVerdict(text: string): 'PASS' | 'PASS_WITH_NOTES' | 'FAIL' {
  // ... search last 5 lines for verdict
}
```

Update `stepRunVerdict`:
```
Both PASS or PASS_WITH_NOTES → done (with notes shown to user)
Any FAIL and fix_attempts < max → fixing
Any FAIL and fix_attempts >= max → failed
```

**B. Calibrate Review Prompts**

Add clearer severity guidance to both review prompts:

For `security-review-prompt.ts`, add:
```
## Severity Classification Rules

- **Critical**: Actively exploitable vulnerability (SQL injection, command injection,
  authentication bypass, hardcoded production credentials)
- **High**: Vulnerability requiring specific conditions to exploit (stored XSS,
  broken access control on specific endpoints, missing RLS on sensitive tables)
- **Medium**: Defence-in-depth gap that isn't directly exploitable
  (missing rate limiting, verbose error messages, missing security headers)
- **Low**: Best practice not followed (console.log statements,
  non-essential TypeScript strict violations)
- **Informational**: Style or convention suggestions

IMPORTANT: This is generated prototype code. Do NOT flag:
- Missing rate limiting as Critical/High (it's a deployment concern)
- Missing CSP headers as Critical/High (platform provides them)
- Theoretical vulnerabilities with no attack vector in context
- Missing features that aren't in the specification
```

For `code-review-prompt.ts`, add:
```
## Severity Classification Rules

- **Critical**: Core functionality from the spec is completely missing or broken
- **High**: A specified feature exists but has a functional bug
- **Medium**: Minor deviations from spec that don't affect core functionality
- **Low**: Style/convention issues
- **Informational**: Suggestions for improvement

IMPORTANT: Focus on what IS specified. Do NOT flag:
- Missing error handling for edge cases not mentioned in the spec
- Missing loading states unless specified
- Code organisation preferences
- Comments or documentation (unless specified)
```

**C. Risk-Level Awareness in Code Review**

The security review already uses risk levels (low/standard/high). Extend this to the code review:

- **Low risk**: Only check completeness of core features; Medium and below → PASS
- **Standard risk**: Current behaviour
- **High risk**: Stricter completeness requirements

---

## Implementation Order

These work packages have some dependencies. The recommended order:

```
WP3 (Static Analysis)     — No dependencies, immediate cost savings
    ↓
WP6 (Review Calibration)  — No dependencies, reduces failure rate
    ↓
WP4 (Token Optimisation)  — Benefits from WP3 (fewer retries to save on)
    ↓
WP1 (Auto-Fix Loop)       — Benefits from WP3+WP6 (fix targets are clearer)
    ↓
WP2 (Faster UI Updates)   — Independent, quality-of-life improvement
    ↓
WP5 (Publish)             — Independent, new feature (Phase 1 only)
```

WP3 and WP6 can be done in parallel as they touch different files. WP2 is frontend-only and can be done in parallel with any backend work.

---

## Files Modified Per Work Package

**WP1 (Auto-Fix Loop)**:
- `api/src/lib/pipeline.ts` — New `stepRunFix`, modified `stepRunVerdict`
- `api/src/lib/agents/fix-prompt.ts` — New file
- `api/src/lib/agents/agent-config.ts` — Add `fixer` config
- `api/src/routes/features.ts` — Reset `fix_attempts` on retry
- `web/src/routes/app/features/[id]/+page.svelte` — Add `fixing` status
- SQL migration: Add `fix_attempts` column, update status CHECK

**WP2 (Faster UI Updates)**:
- `web/src/routes/app/features/[id]/+page.svelte` — Realtime subscription
- `web/src/routes/app/+page.svelte` — Realtime subscription for dashboard
- Supabase dashboard: Enable Realtime on `features` table

**WP3 (Static Analysis)**:
- `api/src/lib/static-analysis.ts` — New file
- `api/src/lib/pipeline.ts` — Integrate static analysis before reviews
- SQL migration: Add `static_analysis_markdown` column

**WP4 (Token Optimisation)**:
- `api/src/lib/anthropic.ts` — Prompt caching headers, system prompt structure
- `api/src/lib/agents/agent-config.ts` — Review token budgets, complexity-based selection
- `api/src/lib/agents/runner.ts` — Pass structured system prompts
- `api/src/lib/pipeline.ts` — Truncation-aware review skipping, complexity scoring
- `api/src/lib/static-analysis.ts` — Code compression utility (add to existing WP3 file)

**WP5 (Publish — Phase 1 only)**:
- `api/src/routes/features.ts` — New `/publish` endpoint
- `api/src/lib/cloudflare-pages.ts` — New file, Cloudflare Pages API wrapper
- `web/src/routes/app/features/[id]/+page.svelte` — Publish button, deployment URL
- SQL migration: Add `deployment_url`, `deployment_status` columns

**WP6 (Review Calibration)**:
- `api/src/lib/agents/security-review-prompt.ts` — Severity rules, prototype context
- `api/src/lib/agents/code-review-prompt.ts` — Severity rules, risk-level awareness
- `api/src/lib/pipeline.ts` — Three-way verdict parsing (PASS/PASS_WITH_NOTES/FAIL)

---

## Database Migrations Summary

All migrations for all work packages (to be run in Supabase SQL Editor):

```sql
-- WP1: Auto-fix loop
ALTER TABLE features ADD COLUMN fix_attempts integer NOT NULL DEFAULT 0;

-- WP3: Static analysis
ALTER TABLE features ADD COLUMN static_analysis_markdown text;

-- WP5: Publish (Phase 1)
ALTER TABLE features ADD COLUMN deployment_url text;
ALTER TABLE features ADD COLUMN deployment_status text
  CHECK (deployment_status IN ('pending', 'deploying', 'deployed', 'failed'));

-- WP1+WP6: Update status CHECK constraint
ALTER TABLE features DROP CONSTRAINT features_status_check;
ALTER TABLE features ADD CONSTRAINT features_status_check
  CHECK (status IN (
    'drafting',
    'spec_generating', 'spec_ready', 'spec_approved',
    'plan_generating', 'plan_ready', 'plan_approved',
    'tests_generating', 'tests_ready', 'tests_approved',
    'implementing', 'review', 'fixing',
    'done', 'failed'
  ));
```

---

## Risk Assessment

| Risk | Mitigation |
|---|---|
| Fix loop creates infinite retry cycles | Hard cap at 1 fix attempt; after that, fail and require user intervention |
| Static analysis false positives block pipeline | Only block on Critical/High static findings; Medium/Low are advisory only |
| Realtime subscription drops silently | Keep polling as fallback; only disable polling if Realtime is actively connected |
| Prompt caching doesn't activate (TTL miss) | No correctness risk; just falls back to full-price calls |
| Cloudflare Pages deployment fails | Best-effort; deployment_status tracks failures; users can still download zip |
| Review calibration makes reviews too lenient | PASS_WITH_NOTES still surfaces issues to users; only Critical/High findings were ever actionable |
