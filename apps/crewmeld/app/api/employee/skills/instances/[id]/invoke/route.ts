/**
 * POST /api/employee/skills/instances/:id/invoke
 *
 * Internal invoke route (session-authenticated, no API key needed).
 * Same logic as the external /api/tools/:instanceId/invoke but uses
 * session auth instead of X-API-Key, and does not require publishedAsApi.
 */
import { db, toolInstances } from '@crewmeld/db'
import { createLogger } from '@crewmeld/logger'
import { eq } from 'drizzle-orm'
import { requirePermission } from '@/lib/auth/rbac/check-permission'
import type { DeployInfo } from '@/app/(employee)/skills/types'

const logger = createLogger('InstanceInvokeAPI')

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requirePermission('skill:deploy')
  if (!auth.authenticated || auth.error) {
    return Response.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  const { id } = await params
  const start = Date.now()

  const [instance] = await db
    .select({ id: toolInstances.id, deploy: toolInstances.deploy })
    .from(toolInstances)
    .where(eq(toolInstances.id, id))
    .limit(1)

  if (!instance) {
    return Response.json({ success: false, error: 'Instance not found' }, { status: 404 })
  }

  const deploy = instance.deploy as DeployInfo | null
  if (deploy?.status !== 'deployed') {
    return Response.json({ success: false, error: 'Tool not deployed' }, { status: 503 })
  }

  let input: unknown
  try {
    const body = (await req.json()) as Record<string, unknown>
    input = body.input ?? {}
  } catch {
    return Response.json({ success: false, error: 'Invalid JSON body' }, { status: 422 })
  }

  // Script-type: ephemeral container invoke
  if (deploy.deployType === 'opensandbox-script') {
    const { invokeScriptTool } = await import('@/lib/tools/script-invoker')
    const result = await invokeScriptTool(deploy, input)
    return Response.json({ ...result, executionTime: result.executionTime })
  }

  // Service / K8s type: HTTP proxy
  const endpoint = deploy.endpoint
  if (!endpoint) {
    return Response.json({ success: false, error: 'No endpoint' }, { status: 503 })
  }

  try {
    const fetchHeaders: Record<string, string> = { 'Content-Type': 'application/json' }
    if (deploy.deployType === 'opensandbox') {
      const apiKey = process.env.OPENSANDBOX_API_KEY
      if (apiKey) fetchHeaders['OPEN-SANDBOX-API-KEY'] = apiKey
    }
    const proxyRes = await fetch(endpoint, {
      method: 'POST',
      headers: fetchHeaders,
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(60_000),
    })

    const text = await proxyRes.text()
    let result: unknown
    try { result = JSON.parse(text) } catch { result = { raw: text } }

    return Response.json({ success: proxyRes.ok, result, executionTime: Date.now() - start })
  } catch (err) {
    logger.error('Instance invoke failed', { id, error: err instanceof Error ? err.message : String(err) })
    return Response.json({ success: false, error: 'Invoke failed' }, { status: 502 })
  }
}
