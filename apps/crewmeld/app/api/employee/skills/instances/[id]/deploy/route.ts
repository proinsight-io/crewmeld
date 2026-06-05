import { db } from '@crewmeld/db'
import { toolInstances, tools } from '@crewmeld/db/schema'
import { createLogger } from '@crewmeld/logger'
import { eq } from 'drizzle-orm'
import { apiAuthErr, apiErr, apiOk } from '@/lib/api/response'
import { withAudit } from '@/lib/audit/with-audit'
import { requirePermission } from '@/lib/auth/rbac/check-permission'
import { resolveConnectionEnvVars } from '@/lib/connectors/resolve-conn-env'
import {
  deploySkill,
  getDeployStatus,
  initWarmPool,
  isK8sConfigured,
  isWarmPoolEnabled,
  undeploySkill,
} from '@/lib/k8s/deploy-skill'
import type { DeployInfo } from '@/app/(employee)/skills/types'

const logger = createLogger('InstanceDeployAPI')

let poolInitialized = false
async function ensureWarmPool(): Promise<void> {
  if (poolInitialized || !isWarmPoolEnabled()) return
  poolInitialized = true
  try {
    await initWarmPool()
    logger.info('Warm pool initialized')
  } catch (err) {
    logger.warn(
      `Warm pool initialization failed: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

async function _POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requirePermission('skill:deploy')
    if (!auth.authenticated || auth.error) {
      return apiAuthErr(auth)
    }

    await ensureWarmPool()

    const { id } = await params

    const [instance] = await db
      .select()
      .from(toolInstances)
      .where(eq(toolInstances.id, id))
      .limit(1)

    if (!instance) {
      return apiErr('api.skill.instanceNotFound', { status: 404 })
    }

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
      })
      .from(tools)
      .where(eq(tools.id, instance.templateId))
      .limit(1)

    // dev-studio tools live on NFS; manual tools use inline code + K8s
    const isCmtool = template?.source === 'dev-studio'

    if (!isCmtool && !isK8sConfigured()) {
      return apiErr('api.skill.k8sNotConfigured', { status: 503 })
    }

    if (!isCmtool && !template?.code) {
      return apiErr('api.skill.templateCodeMissing', { status: 400 })
    }

    const baseEnvVars =
      (instance.envVars as Array<{ name: string; value: string }> | undefined) ??
      (template.envVars as Array<{ name: string; value: string }> | undefined) ??
      []

    // Merge env vars from the bound system connection (e.g. CONN_N8N_BASE_URL).
    // Instance/template env vars win on collision so operators can override per deployment.
    let mergedEnvVars = baseEnvVars
    if (instance.connectionId) {
      try {
        const connEnv = await resolveConnectionEnvVars(instance.connectionId)
        const seen = new Set(baseEnvVars.map((e) => e.name))
        const fromConn = Object.entries(connEnv)
          .filter(([k]) => !seen.has(k))
          .map(([name, value]) => ({ name, value }))
        mergedEnvVars = [...baseEnvVars, ...fromConn]
      } catch (err) {
        logger.warn(`Failed to resolve connection env vars for instance ${id}`, {
          connectionId: instance.connectionId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    const skill = {
      id: instance.id,
      name: instance.name,
      code: template.code,
      language: template.language,
      parameters: template.parameters,
      presetParams: instance.presetParams,
      envVars: mergedEnvVars,
      needsFileMount: template.needsFileMount === true,
      // dev-studio code lives on NFS under the template id, not the instance id.
      // Pass templateId so deploy-skill can find it via paths.toolCode.forBff(templateId).
      ...(isCmtool
        ? {
            templateId: instance.templateId,
            packageSha256: template.packageSha256,
            source: template.source,
          }
        : {}),
    }

    logger.info('Start instance deployment', { instanceId: id, templateId: instance.templateId })

    const result = await deploySkill(skill as Parameters<typeof deploySkill>[0])

    let deploy: DeployInfo
    if (result.deployType === 'opensandbox-script') {
      // Script-type dev-studio tool: no persistent sandbox, no snapshot — code
      // lives on NFS, each invoke creates an ephemeral sandbox. Path derived
      // from template id via paths.toolCode.forSandbox(toolId).
      deploy = {
        status: 'deployed',
        deployType: 'opensandbox-script',
        deployedAt: new Date().toISOString(),
      }
    } else if (result.deployType === 'opensandbox') {
      deploy = {
        status: 'deployed',
        deployType: 'opensandbox',
        endpoint: result.endpoint,
        nodePort: result.nodePort,
        sandboxId: result.sandboxId,
        useProxy: result.useProxy,
        deployedAt: new Date().toISOString(),
      }
    } else {
      deploy = {
        status: 'deployed',
        deployType: 'k8s',
        endpoint: result.endpoint,
        nodePort: result.nodePort,
        deployedAt: new Date().toISOString(),
      }
    }

    await db
      .update(toolInstances)
      .set({ deploy, updatedAt: new Date() })
      .where(eq(toolInstances.id, id))

    logger.info('Instance deployed successfully', { instanceId: id, deployType: deploy.deployType })
    return apiOk(null, { extra: { deploy } })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    logger.error('Instance deployment failed', { error: msg })
    return apiErr('api.skill.deployFailed', { status: 500, extra: { detail: msg } })
  }
}

async function _DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requirePermission('skill:deploy')
    if (!auth.authenticated || auth.error) {
      return apiAuthErr(auth)
    }

    const { id } = await params
    logger.info('Start instance undeployment', { id })

    // Read current deploy info to determine undeploy strategy
    const [instance] = await db
      .select({ deploy: toolInstances.deploy })
      .from(toolInstances)
      .where(eq(toolInstances.id, id))
      .limit(1)

    const currentDeploy = instance?.deploy as DeployInfo | null
    if (currentDeploy?.deployType === 'opensandbox-script') {
      // Script-type dev-studio tool: nothing to tear down — no persistent
      // sandbox, no snapshot. Code stays on NFS until the tool itself is
      // deleted. Just mark the deploy state cleared (handled below).
    } else if (currentDeploy?.deployType === 'opensandbox' && currentDeploy.sandboxId) {
      // Service-type .cmtool: destroy the OpenSandbox container
      const { getOpenSandboxClient } = await import('@/lib/dev-studio/opensandbox-client')
      const client = getOpenSandboxClient()
      await client.destroy(currentDeploy.sandboxId).catch((err) => {
        logger.warn('Sandbox destroy failed during undeploy (non-fatal)', { sandboxId: currentDeploy.sandboxId, error: err })
      })
    } else {
      // Inline-code tool: undeploy via K8s
      await undeploySkill(id)
    }

    const deploy: DeployInfo = { status: 'not_deployed' }
    await db
      .update(toolInstances)
      .set({ deploy, updatedAt: new Date() })
      .where(eq(toolInstances.id, id))

    logger.info('Instance undeployed successfully', { id })
    return apiOk(null, { extra: { deploy } })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    logger.error('Instance undeployment failed', { error: msg })
    return apiErr('api.skill.undeployFailed', { status: 500, extra: { detail: msg } })
  }
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requirePermission('skill:deploy')
    if (!auth.authenticated || auth.error) {
      return apiAuthErr(auth)
    }

    const { id } = await params
    const status = await getDeployStatus(id)
    return apiOk(null, { extra: status })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return apiErr('api.skill.statusQueryFailed', { status: 500, extra: { detail: msg } })
  }
}

export const POST = withAudit(_POST)
export const DELETE = withAudit(_DELETE)
