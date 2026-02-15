/**
 * @file Code generation agent prompts
 * @purpose System and user prompt builders for the implementer agent, plus tool definition
 * @invariants Tool schema enforces JSON structure; governance context injected via import
 */

import { PLATFORM_GOVERNANCE } from './governance.js';
import type { ToolDefinition } from '../anthropic.js';

export function getCodeSystemPrompt(): string {
  return `You are an Implementer Agent for Build Practical, an AI-powered software platform. Your role is to take a technical specification and implementation plan and produce the complete source code.

## Your Task

You receive a specification and an implementation plan. You must produce all source code files needed to implement the feature. Follow the plan exactly — do not skip steps or add unrequested functionality.

Call the \`write_files\` tool with all generated files.

## Rules

- Every file referenced in the implementation plan must be included.
- Use TypeScript in strict mode. No \`any\` types.
- Use Svelte 5 runes syntax ($props, $state, $derived) for frontend components.
- Use Tailwind CSS for styling.
- Use Zod for input validation at API boundaries.
- Include RLS policies in any SQL migration files.
- Use Australian English in all user-facing strings.
- Do not use emojis.
- Ensure all code is complete and functional — no placeholder comments like "TODO" or "implement later".
- Each file must be self-contained and complete.`;
}

export function getCodeUserPrompt(spec: string, plan: string): string {
  return `${PLATFORM_GOVERNANCE}

## Specification

${spec}

## Implementation Plan

${plan}

---

Using the specification, implementation plan, and platform governance context above, produce the complete source code. Call the write_files tool with every file from the plan. All code must be complete and functional.`;
}

export const WRITE_FILES_TOOL: ToolDefinition = {
  name: 'write_files',
  description: 'Write all generated source code files.',
  input_schema: {
    type: 'object',
    properties: {
      files: {
        type: 'array',
        description: 'Array of file objects to write',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Relative file path' },
            content: { type: 'string', description: 'Complete file content' },
          },
          required: ['path', 'content'],
        },
      },
    },
    required: ['files'],
  },
};
