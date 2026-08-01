export interface OpenCodeProviderConfigInput {
  providerID: string
  protocol?: 'anthropic' | 'openai-compatible'
  modelID: string
  baseURL: string
  apiKey: string
}

/** Serialize the per-session OpenCode custom-provider override. */
export function buildOpenCodeConfig(input: OpenCodeProviderConfigInput): string {
  const isAnthropic = input.protocol === 'anthropic'
  return JSON.stringify({
    provider: {
      [input.providerID]: {
        ...(isAnthropic ? {} : { npm: '@ai-sdk/openai-compatible' }),
        options: { baseURL: input.baseURL, apiKey: input.apiKey },
        models: { [input.modelID]: {} },
      },
    },
  })
}
