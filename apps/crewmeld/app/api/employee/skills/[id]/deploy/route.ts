import { db } from '@crewmeld/db'
import { tools } from '@crewmeld/db/schema'
import { createLogger } from '@crewmeld/logger'
import { eq } from 'drizzle-orm'
import { apiAuthErr, apiErr, apiOk } from '@/lib/api/response'
import { withAudit } from '@/lib/audit/with-audit'
import { requirePermission } from '@/lib/auth/rbac/check-permission'
import {
  deploySkill,
  getDeployStatus,
  initWarmPool,
  isK8sConfigured,
  isWarmPoolEnabled,
  undeploySkill,
} from '@/lib/k8s/deploy-skill'
import type { DeployInfo } from '@/app/(employee)/skills/types'

const logger = createLogger('SkillDeployAPI')

let poolInitialized = false
async function ensureWarmPool(): Promise<void> {
  if (poolInitialized || !isWarmPoolEnabled()) return
  poolInitialized = true
  try {
    await initWarmPool()
    logger.info('Warm pool initialized')
  } catch (err) {
    logger.warn(
      `Warm pool initialization failed, falling back to legacy deploy: ${err instanceof Error ? err.message : String(err)}`
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

    if (!isK8sConfigured()) {
      return apiErr('api.skill.k8sNotConfigured', { status: 503 })
    }

    const { id } = await params

    let skill:
      | {
          id: string
          name: string
          code: string
          language?: string
          parameters?: unknown
          presetParams?: unknown
          envVars?: Array<{ name: string; value: string }>
        }
      | undefined
    try {
      const body = await req.json()
      if (body.skill?.code) {
        skill = body.skill
      }
    } catch {
      // Body is empty or not JSON, ignore
    }

    if (!skill) {
      const rows = await db.select().from(tools).where(eq(tools.id, id))
      if (rows.length > 0 && rows[0].code) {
        skill = {
          id: rows[0].id,
          name: rows[0].name,
          code: rows[0].code,
          language: rows[0].language,
          parameters: rows[0].parameters,
          presetParams: rows[0].presetParams,
          envVars: rows[0].envVars as Array<{ name: string; value: string }> | undefined,
        }
      }
    }

    if (!skill) {
      return apiErr('api.skill.notFoundOrMissingData', { status: 404 })
    }
    if (!skill.code) {
      return apiErr('api.skill.noCode', { status: 400 })
    }

    logger.info('Start skill deployment', { id, name: skill.name })

    const result = await deploySkill(skill as Parameters<typeof deploySkill>[0])
    if (result.deployType === 'opensandbox-script') {
      return apiErr('api.skill.deployFailed', { status: 400, extra: { detail: 'Template-level deploy not supported for script-type .cmtool tools' } })
    }

    const deploy: DeployInfo = {
      status: 'deployed',
      deployType: result.deployType,
      endpoint: result.endpoint,
      nodePort: result.nodePort,
      deployedAt: new Date().toISOString(),
    }

    await db.update(tools).set({ deploy, updatedAt: new Date() }).where(eq(tools.id, id))

    logger.info('Skill deployed successfully', { id, endpoint: result.endpoint })
    return apiOk(null, { extra: { deploy } })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    logger.error('Skill deployment failed', { error: msg })
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
    logger.info('Start skill undeployment', { id })

    await undeploySkill(id)

    const deploy: DeployInfo = { status: 'not_deployed' }
    await db.update(tools).set({ deploy, updatedAt: new Date() }).where(eq(tools.id, id))

    logger.info('Skill undeployed successfully', { id })
    return apiOk(null, { extra: { deploy } })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    logger.error('Skill undeployment failed', { error: msg })
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
