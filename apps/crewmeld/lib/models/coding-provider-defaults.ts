import type { CodingProtocol } from '@/providers/models/types'
import { PROVIDER_DEFINITIONS } from '@/providers/models'

export interface CodingProviderDefaults {
  protocol: CodingProtocol
  endpoint: string
  model: string
}

/** Return the configured defaults for a Dev Studio coding provider. */
export function getCodingProviderDefaults(providerId: string): CodingProviderDefaults | null {
  const provider = PROVIDER_DEFINITIONS[providerId]
  if (provider?.category !== 'coding' || !provider.codingProtocol || !provider.defaultEndpoint) {
    return null
  }

  return {
    protocol: provider.codingProtocol,
    endpoint: provider.defaultEndpoint,
    model: provider.defaultModel,
  }
}
