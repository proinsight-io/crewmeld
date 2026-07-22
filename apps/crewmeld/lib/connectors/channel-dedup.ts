import { db } from '@crewmeld/db'
import { systemConnections } from '@crewmeld/db/schema'
import { createLogger } from '@crewmeld/logger'
import { eq } from 'drizzle-orm'
import { decryptConfig } from './encryption'
import { channelIdentityKey } from './sanitize'
import type { ConnectionType } from './types'

const logger = createLogger('ChannelDedup')

/**
 * Find an existing channel of the same type whose credential identity (id +
 * secret, per {@link channelIdentityKey}) matches the given config.
 *
 * Returns the conflicting channel id, or `null` when there is no duplicate —
 * including when the config has no comparable identity (missing credential
 * fields), in which case dedup is skipped.
 *
 * @param type - Channel connection type.
 * @param config - Decrypted, sanitized config to check.
 * @param excludeId - Channel id to skip (the row being edited).
 */
export async function findDuplicateChannel(
  type: ConnectionType,
  config: Record<string, unknown>,
  excludeId?: string
): Promise<string | null> {
  const targetKey = channelIdentityKey(type, config)
  if (!targetKey) return null

  const rows = await db
    .select({ id: systemConnections.id, configEncrypted: systemConnections.configEncrypted })
    .from(systemConnections)
    .where(eq(systemConnections.type, type))

  for (const row of rows) {
    if (excludeId && row.id === excludeId) continue
    let existingConfig: Record<string, unknown>
    try {
      existingConfig = JSON.parse(decryptConfig(row.configEncrypted)) as Record<string, unknown>
    } catch {
      logger.warn(`Failed to decrypt channel config during dedup: ${row.id}`)
      continue
    }
    if (channelIdentityKey(type, existingConfig) === targetKey) {
      return row.id
    }
  }
  return null
}
