export interface ServiceAccessUrlInput {
  instanceId: string
  visibility: 'internal' | 'public'
  internalBaseUrl: string
  customDomain?: string | null
  sharedPublicUrl?: string | null
}

function withSingleTrailingSlash(value: string): string {
  return `${value.replace(/\/+$/, '')}/`
}

function buildCustomDomainUrl(domain: string): string {
  const value = domain.includes('://') ? domain : `https://${domain}`
  return withSingleTrailingSlash(value)
}

/** Build the browser-facing root URL for a published service. */
export function buildServiceAccessUrl(input: ServiceAccessUrlInput): string {
  if (input.visibility === 'public') {
    const customDomain = input.customDomain?.trim()
    if (customDomain) return buildCustomDomainUrl(customDomain)

    const sharedPublicUrl = input.sharedPublicUrl?.trim()
    if (sharedPublicUrl) return withSingleTrailingSlash(sharedPublicUrl)
  }

  const internalBaseUrl = input.internalBaseUrl.replace(/\/+$/, '')
  return `${internalBaseUrl}/services/${encodeURIComponent(input.instanceId)}/`
}
