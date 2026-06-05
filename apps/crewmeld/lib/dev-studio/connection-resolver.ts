/**
 * Connection-derived env prefill heuristic.
 *
 * When the user picks a system_connection in the test panel, we try to
 * auto-fill the env form by matching manifest.env property names against
 * the decrypted connection.config keys. The match is intentionally lossy:
 *   1. Strip a known prefix (MYSQL_/DB_/OPENAI_/...) from the env key.
 *   2. Lower-case + remove [_-] from both sides.
 *   3. Equal? -> prefill.
 *
 * E.g. env key MYSQL_HOST -> 'host' -> matches connection.config.host.
 * env key OPENAI_API_KEY -> 'apikey' -> matches both 'apiKey' and 'api_key'.
 *
 * Unmatched env fields stay blank; the user must fill them by hand.
 */

import { db, systemConnections } from '@crewmeld/db'
import { eq } from 'drizzle-orm'
import { decryptConfig } from '@/lib/connectors/encryption'

export const STRIP_PREFIXES = [
  'MYSQL_',
  'POSTGRES_',
  'PG_',
  'DB_',
  'OPENAI_',
  'GITHUB_',
  'GITLAB_',
  'DISCORD_',
  'TELEGRAM_',
  'WECOM_',
  'DINGTALK_',
  'FEISHU_',
  'WXOA_',
] as const

const SENSITIVE_RE = /password|token|secret|apikey|api_key|apiSecret/i

/**
 * Lower-case both sides and remove [_-]; return true on equality. Used to
 * match "MYSQL_HOST" (after prefix strip -> "HOST") with "host" and
 * "API_KEY" (after strip -> "API_KEY") with "apiKey" / "api_key".
 */
function fuzzyEq(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[_-]/g, '')
  return norm(a) === norm(b)
}

function stripPrefix(envKey: string): string {
  for (const p of STRIP_PREFIXES) {
    if (envKey.startsWith(p)) return envKey.slice(p.length)
  }
  return envKey
}

/**
 * Match env schema properties against connection config keys using the
 * strip-prefix + fuzzy-equal heuristic. Returns only the entries that
 * matched; unmatched env keys are omitted (caller treats them as blank).
 */
export function prefillEnv(
  envSchema: { properties: Record<string, { type: string }> },
  connectionConfig: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  const configKeys = Object.keys(connectionConfig)

  for (const envKey of Object.keys(envSchema.properties)) {
    const stripped = stripPrefix(envKey)
    const match = configKeys.find((k) => fuzzyEq(stripped, k))
    if (match !== undefined) {
      result[envKey] = connectionConfig[match]
    }
  }

  return result
}

/** Return '***' for sensitive-looking keys; original value otherwise. */
export function maskSensitive(key: string, value: unknown): unknown {
  if (SENSITIVE_RE.test(key) && value !== null && value !== undefined) return '***'
  return value
}

export interface ResolvedConnection {
  id: string
  type: string
  subtype?: string
  configDecrypted: Record<string, unknown>
}

/**
 * Look up connection by id, decrypt, return shape suitable for env prefill.
 * Caller is responsible for applying {@link maskSensitive} when forwarding
 * the config to the UI.
 *
 * Returns null if the connection does not exist or decryption fails.
 */
export async function resolveConnection(
  connectionId: string
): Promise<ResolvedConnection | null> {
  const row = await db.query.systemConnections.findFirst({
    where: eq(systemConnections.id, connectionId),
  })
  if (!row) return null

  let configDecrypted: Record<string, unknown>
  try {
    configDecrypted = JSON.parse(decryptConfig(row.configEncrypted)) as Record<string, unknown>
  } catch {
    return null
  }

  const subtype =
    typeof configDecrypted.dbType === 'string' ? configDecrypted.dbType : undefined

  return {
    id: row.id,
    type: row.type,
    subtype,
    configDecrypted,
  }
}
