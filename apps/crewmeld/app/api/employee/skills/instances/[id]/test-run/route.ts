/**
 * POST /api/employee/skills/instances/:id/test-run
 *
 * Test-run a dev-studio tool instance with user-provided env vars and input.
 * Code is read from NFS (paths.toolCode.forBff(templateId)). Delegates to the
 * shared script-invoker so the lifecycle (manifest read → sandbox → NFS volume
 * mounts → exec start.sh on stdin → parse stdout → destroy) is identical to
 * /api/tools/:instanceId/invoke. See spec 2026-05-28 §11.
 *
 * Request body: { input: Record<string, unknown>, envVars?: Record<string, string> }
 */
import { db, toolInstances, tools } from '@crewmeld/db'
import { createLogger } from '@crewmeld/logger'
import { eq } from 'drizzle-orm'
import { requirePermission } from '@/lib/auth/rbac/check-permission'
import { resolveConnectionEnvVars } from '@/lib/connectors/resolve-conn-env'
import { readManifestFromTool } from '@/lib/dev-studio/manifest-reader'
import { invokeScriptTool } from '@/lib/tools/script-invoker'

const logger = createLogger('InstanceTestRun')

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requirePermission('skill:deploy')
  if (!auth.authenticated || auth.error) {
    return Response.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  const { id } = await params
  const start = Date.now()

  const [instance] = await db
    .select({
      id: toolInstances.id,
      templateId: toolInstances.templateId,
      connectionId: toolInstances.connectionId,
      envVars: toolInstances.envVars,
    })
    .from(toolInstances)
    .where(eq(toolInstances.id, id))
    .limit(1)

  if (!instance) {
    return Response.json({ success: false, error: 'Instance not found' }, { status: 404 })
  }

  const [template] = await db
    .select({ source: tools.source, envVars: tools.envVars })
    .from(tools)
    .where(eq(tools.id, instance.templateId))
    .limit(1)

  if (template?.source !== 'dev-studio') {
    return Response.json(
      { success: false, error: 'Only dev-studio tools support skills-page test-run' },
      { status: 400 }
    )
  }

  let body: { input?: Record<string, unknown>; envVars?: Record<string, string> }
  try {
    body = (await req.json()) as typeof body
  } catch {
    return Response.json({ success: false, error: 'Invalid JSON' }, { status: 422 })
  }

  // Read manifest from NFS to discover env schema defaults and kind.
  const manifest = await readManifestFromTool(instance.templateId)
  if (!manifest) {
    return Response.json(
      { success: false, error: 'manifest.json not found on NFS — has the tool been adopted?' },
      { status: 404 }
    )
  }

  if (manifest.kind === 'service') {
    return Response.json(
      {
        success: false,
        error:
          'Service-type tools are tested via the deployed endpoint after deploy. ' +
          'Use the dev-studio run-test panel for pre-deploy validation.',
      },
      { status: 400 }
    )
  }

  // Merge env: manifest defaults < template env < connection env < instance env < user override
  const sandboxEnv: Record<string, string> = {}
  if (manifest.env?.properties) {
    for (const [k, prop] of Object.entries(manifest.env.properties)) {
      if (prop.default !== undefined && prop.default !== null) {
        sandboxEnv[k] = String(prop.default)
      }
    }
  }
  const templateEnvList = (template?.envVars as Array<{ name: string; value: string }> | null) ?? []
  for (const e of templateEnvList) sandboxEnv[e.name] = e.value ?? ''
  if (instance.connectionId) {
    try {
      const connEnv = await resolveConnectionEnvVars(instance.connectionId)
      Object.assign(sandboxEnv, connEnv)
    } catch (err) {
      logger.warn('Failed to resolve connection env vars', { instanceId: id, error: err })
    }
  }
  const instanceEnvList = (instance.envVars as Array<{ name: string; value: string }> | null) ?? []
  for (const e of instanceEnvList) sandboxEnv[e.name] = e.value ?? ''
  Object.assign(sandboxEnv, body.envVars ?? {})

  try {
    const result = await invokeScriptTool({
      toolId: instance.templateId,
      input: body.input ?? {},
      userEnv: sandboxEnv,
    })
    return Response.json({
      success: result.success,
      result: result.result,
      error: result.error,
      executionTime: Date.now() - start,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    logger.error('Test-run failed', { instanceId: id, error: msg })
    return Response.json({ success: false, error: msg, executionTime: Date.now() - start })
  }
}
