/** Normalize exact HTTPS origins and wildcard domain entries. */
export function normalizeAllowedOrigins(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim().replace(/\/$/, '')).filter(Boolean))]
}

/** Validate a supported exact HTTPS origin or wildcard subdomain pattern. */
export function isAllowedOriginPattern(value: string): boolean {
  const normalized = value.trim().replace(/\/$/, '')
  if (/^\*\.[a-z0-9.-]+$/i.test(normalized)) return !normalized.includes('..')
  try {
    const parsed = new URL(normalized)
    return (
      parsed.protocol === 'https:' &&
      parsed.origin === normalized &&
      !parsed.username &&
      !parsed.password
    )
  } catch {
    return false
  }
}

/** Empty allowlists permit any origin; server-to-server requests do not carry Origin. */
export function isOriginAllowed(origin: string | null, allowedOrigins: string[]): boolean {
  if (!origin || allowedOrigins.length === 0) return true
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:') return false
  const normalized = `${parsed.protocol}//${parsed.host}`
  return allowedOrigins.some((entry) => {
    if (entry.startsWith('*.')) {
      const suffix = entry.slice(1).toLowerCase()
      return parsed.hostname.toLowerCase().endsWith(suffix)
    }
    return entry.toLowerCase() === normalized.toLowerCase()
  })
}

/** Accept both repeated and comma-separated query parameters. */
export function parseKnowledgeBaseQuery(search: URLSearchParams): string[] {
  const values = [
    ...search.getAll('knowledgeBaseId'),
    ...search.getAll('knowledgeBaseIds').flatMap((value) => value.split(',')),
  ]
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}
