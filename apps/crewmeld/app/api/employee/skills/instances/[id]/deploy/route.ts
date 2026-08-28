import { db } from '@crewmeld/db'
import { toolInstances, toolServiceReplicas, tools } from '@crewmeld/db/schema'
import { createLogger } from '@crewmeld/logger'
import { eq, sql } from 'drizzle-orm'
import { apiAuthErr, apiErr, apiOk } from '@/lib/api/response'
import { withAudit } from '@/lib/audit/with-audit'
import { requirePermission } from '@/lib/auth/rbac/check-permission'
import { resolveConnectionEnvVars } from '@/lib/connectors/resolve-conn-env'
import { readManifestFromTool } from '@/lib/dev-studio/manifest-reader'
import { deploySkill, isK8sConfigured, undeploySkill } from '@/lib/k8s/deploy-skill'
import {
  destroyServiceReplicas,
  reconcileServiceReplicas,
} from '@/lib/tools/service-deployment-manager'
import type { DeployInfo, ServiceSpec } from '@/app/(employee)/skills/types'

const logger = createLogger('InstanceDeployAPI')

async function _POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requirePermission('skill:deploy')
    if (!auth.authenticated || auth.error) return apiAuthErr(auth)

    const { id } = await params
    const [instance] = await db
      .select()
      .from(toolInstances)
      .where(eq(toolInstances.id, id))
      .limit(1)
    if (!instance) return apiErr('api.skill.instanceNotFound', { status: 404 })

    const [template] = await db
      .select({
        id: tools.id,
        name: tools.name,
        code: tools.code,
        language: tools.language,
        parameters: tools.parameters,
        envVars: tools.envVars,
        needsFileMount: tools.needsFileMount,
        packageSha256: tools.packageSha256,
        source: tools.source,
        kind: tools.kind,
        serviceSpec: tools.serviceSpec,
      })
      .from(tools)
      .where(eq(tools.id, instance.templateId))
      .limit(1)
    if (!template) return apiErr('api.skill.templateNotFound', { status: 404 })

    const isCmtool = template.source === 'dev-studio'
    let effectiveKind = template.kind
    let effectiveServiceSpec = template.serviceSpec as ServiceSpec | null
    if (isCmtool && template.kind === 'script' && !template.serviceSpec) {
      const manifest = await readManifestFromTool(instance.templateId)
      if (manifest?.kind === 'service' && manifest.service) {
        effectiveKind = 'service'
        effectiveServiceSpec = manifest.service
        await db
          .update(tools)
          .set({ kind: 'service', serviceSpec: manifest.service, updatedAt: new Date() })
          .where(eq(tools.id, template.id))
      }
    }
    if (!isCmtool && !isK8sConfigured()) {
      return apiErr('api.skill.k8sNotConfigured', { status: 503 })
    }
    if (!isCmtool && !template.code) {
      return apiErr('api.skill.templateCodeMissing', { status: 400 })
    }

    const baseEnvVars =
      (instance.envVars as Array<{ name: string; value: string }> | undefined) ??
      (template.envVars as Array<{ name: string; value: string }> | undefined) ??
      []
    let mergedEnvVars = baseEnvVars
    if (instance.connectionId) {
      try {
        const connectionEnv = await resolveConnectionEnvVars(instance.connectionId)
        const existingNames = new Set(baseEnvVars.map((entry) => entry.name))
        mergedEnvVars = [
          ...baseEnvVars,
          ...Object.entries(connectionEnv)
            .filter(([name]) => !existingNames.has(name))
            .map(([name, value]) => ({ name, value })),
        ]
      } catch (error) {
        logger.warn('Failed to resolve connection environment variables', {
          instanceId: id,
          connectionId: instance.connectionId,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    const skill = {
      id: instance.id,
      name: instance.name,
      code: template.code ?? undefined,
      language: template.language,
      parameters: template.parameters,
      presetParams: instance.presetParams,
      envVars: mergedEnvVars,
      needsFileMount: template.needsFileMount === true,
      kind: effectiveKind,
      serviceSpec: effectiveServiceSpec,
      ...(isCmtool
        ? {
            templateId: instance.templateId,
            packageSha256: template.packageSha256 ?? undefined,
            source: 'dev-studio' as const,
          }
        : {}),
    } as Parameters<typeof deploySkill>[0]

    logger.info('Starting instance deployment', {
      instanceId: id,
      templateId: instance.templateId,
      desiredReplicas: instance.desiredReplicas,
    })

    let deploy: DeployInfo
    if (effectiveKind === 'service') {
      const replicas = await reconcileServiceReplicas(
        instance.id,
        instance.name,
        skill,
        instance.desiredReplicas
      )
      const ready = replicas.filter((replica) => replica.status === 'ready' && replica.endpoint)
      const first = ready[0]
      deploy = {
        status: ready.length > 0 ? 'deployed' : 'failed',
        deployType: 'opensandbox',
        endpoint: first?.endpoint ?? undefined,
        sandboxId: first?.sandboxId ?? undefined,
        serviceType: effectiveServiceSpec?.type ?? 'json',
        readyReplicas: ready.length,
        deployedAt: new Date().toISOString(),
        ...(ready.length === 0 ? { errorMessage: 'No service replica became ready.' } : {}),
      }
    } else {
      const result = await deploySkill(skill)
      deploy =
        result.deployType === 'opensandbox-script'
          ? {
              status: 'deployed',
              deployType: 'opensandbox-script',
              deployedAt: new Date().toISOString(),
            }
          : {
              status: 'deployed',
              deployType: 'opensandbox',
              endpoint: result.endpoint,
              nodePort: result.nodePort,
              sandboxId: result.sandboxId,
              useProxy: result.useProxy,
              deployedAt: new Date().toISOString(),
            }
    }

    await db
      .update(toolInstances)
      .set({ deploy, updatedAt: new Date() })
      .where(eq(toolInstances.id, id))
    logger.info('Instance deployment completed', {
      instanceId: id,
      deployType: deploy.deployType,
      readyReplicas: deploy.readyReplicas,
    })
    return apiOk(null, { extra: { deploy } })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.error('Instance deployment failed', { error: message })
    return apiErr('api.skill.deployFailed', { status: 500, extra: { detail: message } })
  }
}

async function _DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requirePermission('skill:deploy')
    if (!auth.authenticated || auth.error) return apiAuthErr(auth)

    const { id } = await params
    const [instance] = await db
      .select({ deploy: toolInstances.deploy, templateId: toolInstances.templateId })
      .from(toolInstances)
      .where(eq(toolInstances.id, id))
      .limit(1)
    if (!instance) return apiErr('api.skill.instanceNotFound', { status: 404 })

    const [template] = await db
      .select({ kind: tools.kind })
      .from(tools)
      .where(eq(tools.id, instance.templateId))
      .limit(1)
    const currentDeploy = instance.deploy as DeployInfo | null

    if (template?.kind === 'service') {
      await destroyServiceReplicas(id)
    } else if (currentDeploy?.deployType === 'opensandbox-script') {
      // Script services have no persistent runtime to destroy.
    } else if (currentDeploy?.deployType === 'opensandbox' && currentDeploy.sandboxId) {
      const { getOpenSandboxClient } = await import('@/lib/dev-studio/opensandbox-client')
      await getOpenSandboxClient().destroy(currentDeploy.sandboxId)
    } else {
      await undeploySkill(id)
    }

    const deploy: DeployInfo = { status: 'not_deployed' }
    await db
      .update(toolInstances)
      .set({ deploy, updatedAt: new Date() })
      .where(eq(toolInstances.id, id))
    return apiOk(null, { extra: { deploy } })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.error('Instance undeployment failed', { error: message })
    return apiErr('api.skill.undeployFailed', { status: 500, extra: { detail: message } })
  }
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requirePermission('skill:deploy')
    if (!auth.authenticated || auth.error) return apiAuthErr(auth)
    const { id } = await params
    const [counts] = await db
      .select({
        replicas: sql<number>`count(*)::int`,
        readyReplicas: sql<number>`count(*) filter (where ${toolServiceReplicas.status} = 'ready')::int`,
      })
      .from(toolServiceReplicas)
      .where(eq(toolServiceReplicas.instanceId, id))
    return apiOk(null, {
      extra: {
        ready: (counts?.readyReplicas ?? 0) > 0,
        replicas: counts?.replicas ?? 0,
        readyReplicas: counts?.readyReplicas ?? 0,
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return apiErr('api.skill.statusQueryFailed', { status: 500, extra: { detail: message } })
  }
}

export const POST = withAudit(_POST)
export const DELETE = withAudit(_DELETE)
