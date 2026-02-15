/**
 * @file Per-agent configuration
 * @purpose Central config for model selection and max token limits per agent
 * @invariants Implementer uses Opus for quality; alignment review and title use Haiku for cost
 */

export interface AgentConfig {
  model: string;
  maxTokens: number;
}

type AgentName = 'spec' | 'planner' | 'contract_test' | 'implementer' | 'security_review' | 'code_review' | 'alignment_review' | 'title';

export const AGENT_CONFIGS: Record<AgentName, AgentConfig> = {
  spec:             { model: 'claude-sonnet-4-5-20250929', maxTokens: 12000 },
  planner:          { model: 'claude-sonnet-4-5-20250929', maxTokens: 16000 },
  contract_test:    { model: 'claude-sonnet-4-5-20250929', maxTokens: 12000 },
  implementer:      { model: 'claude-opus-4-6-20250910',  maxTokens: 128000 },
  security_review:  { model: 'claude-sonnet-4-5-20250929', maxTokens: 8192 },
  code_review:      { model: 'claude-sonnet-4-5-20250929', maxTokens: 8192 },
  alignment_review: { model: 'claude-haiku-4-5-20251001',  maxTokens: 500 },
  title:            { model: 'claude-haiku-4-5-20251001',  maxTokens: 50 },
};
