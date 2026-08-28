import { db, toolServiceReplicas } from '@crewmeld/db'
import { and, asc, eq } from 'drizzle-orm'
import { getRedisClient } from '@/lib/core/config/redis'

export interface ReadyServiceReplica {
  id: string
  ordinal: number
  name: string
  endpoint: string
  sandboxId: string
}

const localCursors = new Map<string, number>()

/** Select a ready replica with optional browser-session affinity. */
export async function selectServiceReplica(
  instanceId: string,
  preferredOrdinal?: number
): Promise<ReadyServiceReplica | null> {
  const rows = await db
    .select({
      id: toolServiceReplicas.id,
      ordinal: toolServiceReplicas.ordinal,
      name: toolServiceReplicas.name,
      endpoint: toolServiceReplicas.endpoint,
      sandboxId: toolServiceReplicas.sandboxId,
    })
    .from(toolServiceReplicas)
    .where(
      and(eq(toolServiceReplicas.instanceId, instanceId), eq(toolServiceReplicas.status, 'ready'))
    )
    .orderBy(asc(toolServiceReplicas.ordinal))

  const replicas = rows.filter((row): row is ReadyServiceReplica =>
    Boolean(row.endpoint && row.sandboxId)
  )
  if (replicas.length === 0) return null

  if (preferredOrdinal !== undefined) {
    const preferred = replicas.find((replica) => replica.ordinal === preferredOrdinal)
    if (preferred) return preferred
  }

  const redis = getRedisClient()
  let cursor: number
  if (redis) {
    try {
      cursor = await redis.incr(`crewmeld:service:${instanceId}:round-robin`)
    } catch {
      cursor = (localCursors.get(instanceId) ?? 0) + 1
      localCursors.set(instanceId, cursor)
    }
  } else {
    cursor = (localCursors.get(instanceId) ?? 0) + 1
    localCursors.set(instanceId, cursor)
  }

  return replicas[(cursor - 1) % replicas.length] ?? replicas[0]
}
