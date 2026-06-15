/**
 * POST /api/tools/[instanceId]/invoke
 *
 * External API endpoint for invoking a deployed tool instance.
 * Authentication is via X-API-Key header (no session auth).
 *
 * Script-type tools (deployType === 'opensandbox-script') are executed via an
 * ephemeral OpenSandbox container with NFS volumes mounted in — code is read
 * from `paths.toolCode.forSandbox(toolId)` and shared Python deps from
 * `paths.sharedLibs.forSandbox()`. See spec 2026-05-28 §11.1.
 *
 * Service-type tools continue to be invoked via HTTP proxy to the long-lived
 * sandbox endpoint (spec §11.2).
 */

import { db, toolExecutions, toolInstanceApiKeys, toolInstances, tools } from '@crewmeld/db'
import { and, eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { generateExecutionId } from '@/lib/core/execution-id'
import { hashApiKey } from '@/lib/tools/api-key-service'
import { createLogger } from '@crewmeld/logger'
import { forwardableHeaders } from '@/lib/tools/forwardable-headers'

const logger = createLogger('API:Tools:Invoke')

/** JSONB shape stored in toolInstances.deploy that this route reads. */
interface DeployInfo {
  status?: string
  endpoint?: string
  deployType?: 'k8s' | 'opensandbox' | 'opensandbox-script'
  useProxy?: boolean
  serviceMethod?: string
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ instanceId: string }> }
) {
  const start = Date.now()

  // 1. Validate X-API-Key header
  const apiKey = request.headers.get('X-API-Key')
  if (!apiKey) {
    return NextResponse.json(
      { success: false, error: 'Missing API key' },
      { status: 401 }
    )
  }

  const { instanceId } = await params

  // 2. Hash the key and look up a matching active record for this instance
  const hashedKey = hashApiKey(apiKey)

  const [keyRecord] = await db
    .select({ id: toolInstanceApiKeys.id })
    .from(toolInstanceApiKeys)
    .where(
      and(
        eq(toolInstanceApiKeys.hashedKey, hashedKey),
        eq(toolInstanceApiKeys.instanceId, instanceId),
        eq(toolInstanceApiKeys.active, true)
      )
    )
    .limit(1)

  if (!keyRecord) {
    return NextResponse.json(
      { success: false, error: 'Invalid API key' },
      { status: 401 }
    )
  }

  // 4. Update lastUsedAt asynchronously — fire-and-forget, do not block the request
  db.update(toolInstanceApiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(toolInstanceApiKeys.id, keyRecord.id))
    .catch((err: unknown) => {
      logger.error('Failed to update lastUsedAt for API key', {
        keyId: keyRecord.id,
        error: err instanceof Error ? err.message : String(err),
      })
    })

  // 5. Load the tool instance + its template id (needed for NFS code mount
  //    when the instance is a script-type dev-studio tool). `createdBy` is
  //    used to attribute the tool_executions row to a real user so the
  //    /api/employee/tool-execution/[execId]/files/* endpoints can authorize
  //    follow-up IO access (spec §9.5).
  const [instance] = await db
    .select({
      id: toolInstances.id,
      templateId: toolInstances.templateId,
      publishedAsApi: toolInstances.publishedAsApi,
      deploy: toolInstances.deploy,
      envVars: toolInstances.envVars,
      createdBy: toolInstances.createdBy,
      kind: tools.kind,
      apiSpec: tools.apiSpec,
      forwardIdentity: tools.forwardIdentity,
    })
    .from(toolInstances)
    .innerJoin(tools, eq(tools.id, toolInstances.templateId))
    .where(eq(toolInstances.id, instanceId))
    .limit(1)

  if (!instance) {
    return NextResponse.json(
      { success: false, error: 'Instance not found' },
      { status: 404 }
    )
  }

  if (!instance.publishedAsApi) {
    return NextResponse.json(
      { success: false, error: 'Instance not published as API' },
      { status: 403 }
    )
  }

  // Caller's inbound headers, filtered to the forwardable subset (platform
  // secrets / hop-by-hop headers removed). Made available to every tool kind:
  // proxied to web-service backends, injected into script stdin as `_headers`,
  // and exposed to API tools as `ctx.headers` (+ overlaid on their outbound call).
  const inboundHeaders = forwardableHeaders(request.headers)

  // API tools run in-process (no container, no deploy). Short-circuit here.
  if (instance.kind === 'api') {
    if (!instance.apiSpec) {
      return NextResponse.json({ success: false, error: 'API tool spec missing' }, { status: 500 })
    }
    let input: unknown
    try {
      const body = await request.json()
      if (body === null || typeof body !== 'object' || !('input' in body)) {
        return NextResponse.json(
          { success: false, error: 'Request body must contain an "input" field' },
          { status: 422 }
        )
      }
      input = (body as Record<string, unknown>)['input']
    } catch {
      return NextResponse.json({ success: false, error: 'Invalid JSON body' }, { status: 422 })
    }
    const { runApiTool } = await import('@/lib/tools/api-tool-runner')
    const { buildApiToolDeps } = await import('@/lib/tools/api-tool-deps')
    // External invoke path has no platform-resolved caller identity: the request
    // carries only an API key, not an IM channel user id. If this tool declares
    // forwardIdentity=true the runner will fail-closed (no identity → no call),
    // which is correct — external callers must not bypass identity enforcement.
    const forwardIdentity = instance.forwardIdentity === true
    const r = await runApiTool(
      instance.apiSpec as import('@/lib/tools/api-tool-types').ApiToolSpec,
      input,
      buildApiToolDeps(),
      { toolId: instance.templateId, forwardIdentity, headers: inboundHeaders }
    )
    const executionTime = Date.now() - start
    return NextResponse.json({
      success: r.success,
      ...(r.success ? { result: r.result } : { error: r.error }),
      executionTime,
    })
  }

  const deploy = instance.deploy as DeployInfo | null

  if (deploy?.status !== 'deployed') {
    return NextResponse.json(
      { success: false, error: 'Tool not deployed' },
      { status: 503 }
    )
  }

  const isScript = deploy.deployType === 'opensandbox-script'
  if (!isScript && !deploy.endpoint) {
    return NextResponse.json(
      { success: false, error: 'Tool not deployed (missing endpoint)' },
      { status: 503 }
    )
  }

  // 6. Parse request body and extract input
  let input: unknown
  try {
    const body = await request.json()
    if (body === null || typeof body !== 'object' || !('input' in body)) {
      return NextResponse.json(
        { success: false, error: 'Request body must contain an "input" field' },
        { status: 422 }
      )
    }
    input = (body as Record<string, unknown>)['input']
  } catch {
    return NextResponse.json(
      { success: false, error: 'Invalid JSON body' },
      { status: 422 }
    )
  }

  // 7. Execute tool — script-type uses ephemeral containers, others use HTTP proxy
  if (isScript) {
    // Persist a tool_executions row BEFORE creating the sandbox so the
    // generated execId is durable: subsequent /tool-execution/[execId]/files
    // calls can authorize the caller via tool_instances.createdBy.
    const execId = generateExecutionId('inv')
    try {
      await db.insert(toolExecutions).values({
        id: execId,
        userId: instance.createdBy,
        instanceId: instance.id,
      })
    } catch (err) {
      logger.error('Failed to persist tool_executions row', {
        instanceId,
        execId,
        error: err instanceof Error ? err.message : String(err),
      })
      return NextResponse.json(
        { success: false, error: 'Failed to record execution' },
        { status: 500 }
      )
    }

    const { invokeScriptTool } = await import('@/lib/tools/script-invoker')
    const userEnv = Object.fromEntries(
      ((instance.envVars as Array<{ name: string; value: string }> | null) ?? []).map((e) => [
        e.name,
        String(e.value ?? ''),
      ])
    )
    const scriptResult = await invokeScriptTool({
      toolId: instance.templateId,
      input,
      userEnv,
      execId,
      headers: inboundHeaders,
    })
    return NextResponse.json({
      success: scriptResult.success,
      result: scriptResult.result,
      ...(scriptResult.error ? { error: scriptResult.error } : {}),
      executionId: execId,
      executionTime: scriptResult.executionTime,
    })
  }

  let proxyResponse: Response
  try {
    // Forward inbound headers (custom headers, downstream auth) to the tool
    // backend. Platform-controlled headers are applied afterwards so they
    // always win over any caller-supplied value.
    const fetchHeaders: Record<string, string> = { ...inboundHeaders }
    fetchHeaders['Content-Type'] = 'application/json'
    if (deploy.deployType === 'opensandbox') {
      const apiKey = process.env.OPENSANDBOX_API_KEY
      if (apiKey) fetchHeaders['OPEN-SANDBOX-API-KEY'] = apiKey
    }
    proxyResponse = await fetch(deploy.endpoint!, {
      method: deploy.serviceMethod ?? 'POST',
      headers: fetchHeaders,
      body: JSON.stringify(input),
    })
  } catch (err) {
    logger.error('Proxy fetch failed', {
      instanceId,
      endpoint: deploy.endpoint,
      error: err instanceof Error ? err.message : String(err),
    })
    return NextResponse.json(
      { success: false, error: 'Proxy request failed' },
      { status: 502 }
    )
  }

  if (!proxyResponse.ok) {
    logger.error('Proxy returned non-OK status', {
      instanceId,
      status: proxyResponse.status,
    })
    return NextResponse.json(
      { success: false, error: 'Proxy request failed' },
      { status: 502 }
    )
  }

  // 8. Parse proxy response — try JSON, fall back to { raw: text }
  const responseText = await proxyResponse.text()
  let result: unknown
  try {
    result = JSON.parse(responseText)
  } catch {
    result = { raw: responseText }
  }

  // 9. Return success envelope with execution time
  const executionTime = Date.now() - start
  return NextResponse.json({ success: true, result, executionTime })
}
