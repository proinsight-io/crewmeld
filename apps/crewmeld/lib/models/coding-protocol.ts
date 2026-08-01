import type { CodingProtocol } from '@/providers/models/types'
import { PROVIDER_DEFINITIONS } from '@/providers/models'

/** Resolve an explicit protocol while preserving legacy Anthropic endpoints. */
export function resolveCodingProtocol(
  providerId: string,
  endpoint: string | null | undefined
): CodingProtocol {
  if (endpoint && /\/anthropic(?:\/|$)/i.test(endpoint)) return 'anthropic'
  return PROVIDER_DEFINITIONS[providerId]?.codingProtocol ?? 'openai-compatible'
}
