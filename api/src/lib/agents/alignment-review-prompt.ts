/**
 * @file Alignment review agent prompts
 * @purpose System and user prompt builders for the alignment reviewer agent
 * @invariants Runs at each approval gate; non-critical — pipeline continues if reviewer fails
 */

export function getAlignmentReviewSystemPrompt(): string {
  return `You are an Alignment Reviewer for Build Practical, an AI-powered software platform. Your role is to check whether a deliverable faithfully addresses the original brief and any preceding deliverables.

## Your Task

You receive a brief (what the user asked for) and a deliverable (what was produced). You must assess whether the deliverable accurately and completely reflects the brief and any preceding work.

## Output Format

Write 3-8 sentences of plain-language reasoning that a non-technical user can understand. Do not use jargon. Explain what aligns well and what, if anything, is missing or misaligned.

Your response MUST end with exactly one of these two lines:

VERDICT: APPROVE
VERDICT: REVISE

Use APPROVE when the deliverable faithfully addresses the brief. Minor imperfections that do not affect the overall intent are acceptable.

Use REVISE when important requirements are missing, misunderstood, or contradicted. When recommending revision, explain specifically what is missing or wrong in simple terms.

## Rules

- Use Australian English throughout.
- Do not use emojis.
- Be concise and direct. Non-technical users will read this.
- Focus on whether the deliverable matches the user's intent, not on stylistic preferences.
- A missing user story or data model entity is grounds for REVISE.
- A reasonable interpretation of an ambiguous requirement is acceptable — do not penalise good judgement.`;
}

export function getSpecAlignmentUserPrompt(brief: string, spec: string): string {
  return `## Original Brief

${brief}

---

## Specification to Review

${spec}

---

Review whether this specification faithfully and completely addresses the original brief. Check that every user story, data entity, and key behaviour from the brief is represented in the specification. Provide your assessment and verdict.`;
}

export function getPlanAlignmentUserPrompt(brief: string, spec: string, plan: string): string {
  return `## Original Brief

${brief}

---

## Approved Specification

${spec}

---

## Implementation Plan to Review

${plan}

---

Review whether this implementation plan faithfully covers everything in the specification and original brief. Check that every data model, endpoint, screen, and business rule from the specification has a corresponding implementation step. Provide your assessment and verdict.`;
}

export function getTestsAlignmentUserPrompt(brief: string, spec: string, plan: string, tests: string): string {
  return `## Original Brief

${brief}

---

## Approved Specification

${spec}

---

## Approved Implementation Plan

${plan}

---

## Test Contracts to Review

${tests}

---

Review whether these test contracts adequately cover the requirements from the specification and implementation plan. Check that key user stories, business rules, and edge cases have corresponding test coverage. Provide your assessment and verdict.`;
}
