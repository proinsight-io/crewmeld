import { db } from '@crewmeld/db'
import { systemConnections } from '@crewmeld/db/schema'
import { createLogger } from '@crewmeld/logger'
import { eq } from 'drizzle-orm'
import { decryptConfig } from './encryption'

const logger = createLogger('ResolveConnEnv')

/**
 * Convert camelCase config key to CONN_ environment variable name.
 * e.g. host -> CONN_HOST, apiKey -> CONN_API_KEY, dbType -> CONN_DB_TYPE
 */
function configKeyToEnvName(key: string): string {
  return `CONN_${key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()}`
}

/**
 * Convert a decrypted connection config object into `CONN_*` environment
 * variables for the sandbox. Pure (no I/O) so it can be unit-tested.
 *
 * Scalar values are stringified directly. Non-scalar values (arrays / nested
 * objects, e.g. the openclaw `endpoints` pool) are JSON-encoded — `String()`
 * would otherwise collapse them to `"[object Object]"` and destroy the data.
 * Empty / null values are skipped (they are not injected). The synthetic
 * `CONN_TYPE` is always appended.
 */
export function configToConnEnvVars(
  config: Record<string, unknown>,
  type: string
): Record<string, string> {
  const envVars: Record<string, string> = {}
  for (const [key, value] of Object.entries(config)) {
    if (value != null && value !== '') {
      envVars[configKeyToEnvName(key)] =
        typeof value === 'object' ? JSON.stringify(value) : String(value)
    }
  }

  // Additionally inject connection type for tool code convenience
  envVars.CONN_TYPE = type

  return envVars
}

/** A bound connection described for a coding agent's benefit — never its values. */
export interface ConnectionEnvKeyInfo {
  name: string
  type: string
  /** The `CONN_*` variable names this connection will inject at run time. */
  envKeys: string[]
}

/**
 * Describe a connection to the coding agent: its name, type, and the exact
 * `CONN_*` variable names the sandbox will inject for it.
 *
 * Derived from the same decrypted config and the same {@link configKeyToEnvName}
 * transform as {@link resolveConnectionEnvVars}, so the names an agent is told
 * to read and the names actually injected cannot drift apart. Only key *names*
 * cross this boundary — no credential values.
 *
 * Throws when the connection is missing or cannot be decrypted. Callers must
 * decide what a failure means: for AGENTS.md the honest outcome is to omit the
 * connection section, not to emit one listing no variables (which would read to
 * the model as "this connection injects nothing").
 */
export async function resolveConnectionEnvKeys(
  connectionId: string
): Promise<ConnectionEnvKeyInfo> {
  const [conn] = await db
    .select({
      name: systemConnections.name,
      configEncrypted: systemConnections.configEncrypted,
      type: systemConnections.type,
    })
    .from(systemConnections)
    .where(eq(systemConnections.id, connectionId))
    .limit(1)

  if (!conn) throw new Error(`Connection not found: ${connectionId}`)

  const config = JSON.parse(decryptConfig(conn.configEncrypted)) as Record<string, unknown>
  return {
    name: conn.name,
    type: conn.type,
    envKeys: Object.keys(configToConnEnvVars(config, conn.type)),
  }
}

/**
 * Decrypt connection config by connectionId and convert to CONN_* environment variables.
 * Returns empty object if connectionId is invalid or connection does not exist.
 */
export async function resolveConnectionEnvVars(
  connectionId: string
): Promise<Record<string, string>> {
  try {
    const [conn] = await db
      .select({
        configEncrypted: systemConnections.configEncrypted,
        type: systemConnections.type,
      })
      .from(systemConnections)
      .where(eq(systemConnections.id, connectionId))
      .limit(1)

    if (!conn) {
      logger.warn(`Connection not found: ${connectionId}`)
      return {}
    }

    const configJson = decryptConfig(conn.configEncrypted)
    const config = JSON.parse(configJson) as Record<string, unknown>

    return configToConnEnvVars(config, conn.type)
  } catch (error) {
    logger.error(`Failed to resolve connection config: ${connectionId}`, { error })
    return {}
  }
}
