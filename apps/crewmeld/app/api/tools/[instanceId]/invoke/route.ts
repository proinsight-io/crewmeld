/** External JSON invocation endpoint retained for API, script, and JSON service tools. */
import { db, toolExecutions, toolInstanceApiKeys, toolInstances, tools } from '@crewmeld/db'
import { createLogger } from '@crewmeld/logger'
import { and, eq } from 'drizzle-orm'
import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { generateExecutionId } from '@/lib/core/execution-id'
import { getOpenSandboxClient } from '@/lib/dev-studio/opensandbox-client'
import { hashApiKey } from '@/lib/tools/api-key-service'
import { forwardableHeaders } from '@/lib/tools/forwardable-headers'
import { selectServiceReplica } from '@/lib/tools/service-replica-selector'
import type { DeployInfo, ServiceSpec } from '@/app/(employee)/skills/types'

const logger = createLogger('API:Tools:Invoke')

async function authenticate(request: NextRequest, instanceId: string, authMode: string) {
  if (authMode === 'anonymous') return true
  const apiKey = request.headers.get('X-API-Key')
  if (!apiKey) return false
  const [record] = await db
    .select({ id: toolInstanceApiKeys.id })
    .from(toolInstanceApiKeys)
    .where(
      and(
        eq(toolInstanceApiKeys.hashedKey, hashApiKey(apiKey)),
        eq(toolInstanceApiKeys.instanceId, instanceId),
        eq(toolInstanceApiKeys.active, true)
      )
    )
    .limit(1)
  if (!record) return false
  void db
    .update(toolInstanceApiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(toolInstanceApiKeys.id, record.id))
  return true
}

function parseInput(body: unknown): { ok: true; input: unknown } | { ok: false } {
  if (body === null || typeof body !== 'object' || !('input' in body)) return { ok: false }
  return { ok: true, input: (body as Record<string, unknown>).input }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ instanceId: string }> }
) {
  const start = Date.now()
  const { instanceId } = await params
  const [instance] = await db
    .select({
      id: toolInstances.id,
      templateId: toolInstances.templateId,
      publishedAsService: toolInstances.publishedAsService,
      serviceAuthMode: toolInstances.serviceAuthMode,
      deploy: toolInstances.deploy,
      envVars: toolInstances.envVars,
      createdBy: toolInstances.createdBy,
      kind: tools.kind,
      serviceSpec: tools.serviceSpec,
      apiSpec: tools.apiSpec,
      forwardIdentity: tools.forwardIdentity,
    })
    .from(toolInstances)
    .innerJoin(tools, eq(tools.id, toolInstances.templateId))
    .where(eq(toolInstances.id, instanceId))
    .limit(1)
  if (!instance) {
    return NextResponse.json({ success: false, error: 'Instance not found' }, { status: 404 })
  }
  if (!instance.publishedAsService) {
    return NextResponse.json({ success: false, error: 'Service is not published' }, { status: 403 })
  }
  if (!(await authenticate(request, instanceId, instance.serviceAuthMode))) {
    return NextResponse.json(
      { success: false, error: 'Invalid or missing API key' },
      { status: 401 }
    )
  }

  let parsedBody: unknown
  try {
    parsedBody = await request.json()
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON body' }, { status: 422 })
  }
  const parsedInput = parseInput(parsedBody)
  if (!parsedInput.ok) {
    return NextResponse.json(
      { success: false, error: 'Request body must contain an "input" field' },
      { status: 422 }
    )
  }
  const input = parsedInput.input
  const inboundHeaders = forwardableHeaders(request.headers)

  if (instance.kind === 'api') {
    if (!instance.apiSpec) {
      return NextResponse.json({ success: false, error: 'API tool spec missing' }, { status: 500 })
    }
    const { runApiTool } = await import('@/lib/tools/api-tool-runner')
    const { buildApiToolDeps } = await import('@/lib/tools/api-tool-deps')
    const result = await runApiTool(
      instance.apiSpec as import('@/lib/tools/api-tool-types').ApiToolSpec,
      input,
      buildApiToolDeps(),
      {
        toolId: instance.templateId,
        forwardIdentity: instance.forwardIdentity === true,
        headers: inboundHeaders,
      }
    )
    return NextResponse.json({
      success: result.success,
      ...(result.success ? { result: result.result } : { error: result.error }),
      executionTime: Date.now() - start,
    })
  }

  const deploy = instance.deploy as DeployInfo | null
  if (deploy?.status !== 'deployed') {
    return NextResponse.json({ success: false, error: 'Tool not deployed' }, { status: 503 })
  }

  if (deploy.deployType === 'opensandbox-script') {
    const executionId = generateExecutionId('inv')
    await db.insert(toolExecutions).values({
      id: executionId,
      userId: instance.createdBy,
      instanceId: instance.id,
    })
    const { invokeScriptTool } = await import('@/lib/tools/script-invoker')
    const userEnv = Object.fromEntries(
      ((instance.envVars as Array<{ name: string; value: string }> | null) ?? []).map((entry) => [
        entry.name,
        String(entry.value ?? ''),
      ])
    )
    const result = await invokeScriptTool({
      toolId: instance.templateId,
      input,
      userEnv,
      execId: executionId,
      headers: inboundHeaders,
    })
    return NextResponse.json({ ...result, executionId })
  }

  const serviceSpec = (instance.serviceSpec as ServiceSpec | null) ?? {
    type: 'json',
    port: 3000,
    path: '/',
    method: 'POST',
  }
  if (serviceSpec.type !== 'json') {
    return NextResponse.json(
      { success: false, error: `Use /services/${instanceId}/ for ${serviceSpec.type} services.` },
      { status: 409 }
    )
  }

  const replica = await selectServiceReplica(instanceId)
  const endpoint = replica?.endpoint ?? deploy.endpoint
  if (!endpoint) {
    return NextResponse.json(
      { success: false, error: 'No healthy service replica' },
      { status: 503 }
    )
  }

  try {
    const headers: Record<string, string> = {
      ...inboundHeaders,
      'Content-Type': 'application/json',
      ...getOpenSandboxClient().proxyHeaders(),
    }
    const upstream = await fetch(endpoint, {
      method: serviceSpec.method,
      headers,
      body: serviceSpec.method === 'GET' ? undefined : JSON.stringify(input),
    })
    const text = await upstream.text()
    let result: unknown
    try {
      result = text ? JSON.parse(text) : null
    } catch {
      result = { raw: text }
    }
    if (!upstream.ok) {
      return NextResponse.json(
        { success: false, error: `Service returned HTTP ${upstream.status}`, result },
        { status: 502 }
      )
    }
    return NextResponse.json({ success: true, result, executionTime: Date.now() - start })
  } catch (error) {
    logger.error('Service invocation failed', {
      instanceId,
      error: error instanceof Error ? error.message : String(error),
    })
    return NextResponse.json({ success: false, error: 'Service proxy failed' }, { status: 502 })
  }
}
