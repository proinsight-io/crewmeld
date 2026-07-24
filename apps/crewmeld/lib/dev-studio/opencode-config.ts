export interface OpenCodeProviderConfigInput {
  providerID: string
  modelID: string
  baseURL: string
  apiKey: string
}

/** Serialize the per-session OpenCode custom-provider override. */
export function buildOpenCodeConfig(input: OpenCodeProviderConfigInput): string {
  return JSON.stringify({
    provider: {
      [input.providerID]: {
        npm: '@ai-sdk/openai-compatible',
        options: { baseURL: input.baseURL, apiKey: input.apiKey },
        models: { [input.modelID]: {} },
      },
    },
  })
}
