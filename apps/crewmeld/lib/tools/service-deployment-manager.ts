import { randomUUID } from 'node:crypto'
import { db, toolServiceReplicas } from '@crewmeld/db'
import { createLogger } from '@crewmeld/logger'
import { eq } from 'drizzle-orm'
import { acquireLock, releaseLock } from '@/lib/core/config/redis'
import { getOpenSandboxClient } from '@/lib/dev-studio/opensandbox-client'
import { deployServiceReplica } from '@/lib/k8s/deploy-skill'
import type { SkillPackage } from '@/app/(employee)/skills/types'

const logger = createLogger('ServiceDeploymentManager')

export const MIN_SERVICE_REPLICAS = 1
export const MAX_SERVICE_REPLICAS = 20

export interface ServiceReplicaState {
  id: string
  ordinal: number
  name: string
  sandboxId: string | null
  endpoint: string | null
  status: string
  errorMessage: string | null
}

function replicaId(instanceId: string, ordinal: number): string {
  return `${instanceId}:${ordinal}`
}

function replicaName(instanceName: string, ordinal: number): string {
  return `${instanceName}-${ordinal}`
}

/** Reconcile persistent OpenSandbox replicas to the requested count. */
async function reconcileServiceReplicasUnlocked(
  instanceId: string,
  instanceName: string,
  skill: SkillPackage,
  desiredReplicas: number
): Promise<ServiceReplicaState[]> {
  if (
    !Number.isInteger(desiredReplicas) ||
    desiredReplicas < MIN_SERVICE_REPLICAS ||
    desiredReplicas > MAX_SERVICE_REPLICAS
  ) {
    throw new Error(
      `Replica count must be between ${MIN_SERVICE_REPLICAS} and ${MAX_SERVICE_REPLICAS}.`
    )
  }

  const current = await db
    .select()
    .from(toolServiceReplicas)
    .where(eq(toolServiceReplicas.instanceId, instanceId))
  const byOrdinal = new Map(current.map((replica) => [replica.ordinal, replica]))

  const scaleDown = current
    .filter((replica) => replica.ordinal >= desiredReplicas)
    .sort((a, b) => b.ordinal - a.ordinal)
  for (const replica of scaleDown) {
    await db
      .update(toolServiceReplicas)
      .set({ status: 'stopping', updatedAt: new Date() })
      .where(eq(toolServiceReplicas.id, replica.id))
    if (replica.sandboxId) {
      await getOpenSandboxClient()
        .destroy(replica.sandboxId)
        .catch((error: unknown) => {
          logger.warn('Failed to destroy service replica during scale down', {
            instanceId,
            ordinal: replica.ordinal,
            error: error instanceof Error ? error.message : String(error),
          })
        })
    }
    await db.delete(toolServiceReplicas).where(eq(toolServiceReplicas.id, replica.id))
    byOrdinal.delete(replica.ordinal)
  }

  for (let ordinal = 0; ordinal < desiredReplicas; ordinal += 1) {
    const existing = byOrdinal.get(ordinal)
    if (existing?.status === 'ready' && existing.endpoint && existing.sandboxId) continue

    const id = replicaId(instanceId, ordinal)
    const name = replicaName(instanceName, ordinal)
    if (existing) {
      await db
        .update(toolServiceReplicas)
        .set({ name, status: 'creating', errorMessage: null, updatedAt: new Date() })
        .where(eq(toolServiceReplicas.id, id))
    } else {
      await db.insert(toolServiceReplicas).values({ id, instanceId, ordinal, name })
    }

    try {
      const deployed = await deployServiceReplica(skill, ordinal)
      await db
        .update(toolServiceReplicas)
        .set({
          sandboxId: deployed.sandboxId,
          endpoint: deployed.endpoint,
          status: 'ready',
          errorMessage: null,
          updatedAt: new Date(),
        })
        .where(eq(toolServiceReplicas.id, id))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await db
        .update(toolServiceReplicas)
        .set({ status: 'failed', errorMessage: message, updatedAt: new Date() })
        .where(eq(toolServiceReplicas.id, id))
      logger.error('Service replica deployment failed', { instanceId, ordinal, error: message })
    }
  }

  return db
    .select({
      id: toolServiceReplicas.id,
      ordinal: toolServiceReplicas.ordinal,
      name: toolServiceReplicas.name,
      sandboxId: toolServiceReplicas.sandboxId,
      endpoint: toolServiceReplicas.endpoint,
      status: toolServiceReplicas.status,
      errorMessage: toolServiceReplicas.errorMessage,
    })
    .from(toolServiceReplicas)
    .where(eq(toolServiceReplicas.instanceId, instanceId))
}

/** Serialize replica reconciliation across CrewMeld application replicas. */
export async function reconcileServiceReplicas(
  instanceId: string,
  instanceName: string,
  skill: SkillPackage,
  desiredReplicas: number
): Promise<ServiceReplicaState[]> {
  const lockKey = `crewmeld:service:${instanceId}:reconcile`
  const owner = randomUUID()
  if (!(await acquireLock(lockKey, owner, 600))) {
    throw new Error('Service scaling is already in progress.')
  }
  try {
    return await reconcileServiceReplicasUnlocked(instanceId, instanceName, skill, desiredReplicas)
  } finally {
    await releaseLock(lockKey, owner)
  }
}

/** Destroy every persistent replica owned by a service instance. */
export async function destroyServiceReplicas(instanceId: string): Promise<void> {
  const replicas = await db
    .select()
    .from(toolServiceReplicas)
    .where(eq(toolServiceReplicas.instanceId, instanceId))
  const client = getOpenSandboxClient()
  for (const replica of replicas) {
    if (replica.sandboxId) {
      await client.destroy(replica.sandboxId).catch((error: unknown) => {
        logger.warn('Failed to destroy service replica', {
          instanceId,
          ordinal: replica.ordinal,
          error: error instanceof Error ? error.message : String(error),
        })
      })
    }
  }
  await db.delete(toolServiceReplicas).where(eq(toolServiceReplicas.instanceId, instanceId))
}
