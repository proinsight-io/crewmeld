/**
 * Pricing and token-accounting types for CrewMeld provider adapters.
 */

/**
 * Identifies one of the supported LLM backend vendors.
 * Covers OpenAI-compatible APIs plus the eight domestic Chinese model vendors
 * targeted by the CrewMeld enterprise deployment.
 */
export type ProviderId =
  | 'anthropic'
  | 'claude-coding'
  | 'deepseek'
  | 'doubao'
  | 'ernie'
  | 'google'
  | 'hunyuan'
  | 'kimi-coding'
  | 'minimax'
  | 'moonshot'
  | 'ollama'
  | 'openai'
  | 'qianfan-coding'
  | 'qwen'
  | 'qwen-coding'
  | 'vllm'
  | 'zhipu'

/** Rate card for a single model, denominated in USD per one-million tokens. */
export interface ModelPricing {
  /** Prompt token cost — USD / 1 M tokens. */
  input: number
  /** Cached-prompt discount rate, when the vendor supports prompt caching. */
  cachedInput?: number
  /** Completion token cost — USD / 1 M tokens. */
  output: number
  /** ISO-8601 date the rate card was last verified against the vendor's pricing page. */
  updatedAt: string
}

/** Index of {@link ModelPricing} records keyed by model identifier. */
export type ModelPricingMap = Record<string, ModelPricing>
