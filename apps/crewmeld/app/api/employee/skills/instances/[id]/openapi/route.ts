import { db, toolInstances, tools } from '@crewmeld/db'
import { eq } from 'drizzle-orm'
import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { apiAuthErr } from '@/lib/api/response'
import { requirePermission } from '@/lib/auth/rbac/check-permission'

/** Return an OpenAPI document for a published tool instance. */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requirePermission('skill:list')
  if (!auth.authenticated || auth.error) return apiAuthErr(auth)
  const { id } = await params
  const [instance] = await db
    .select({
      id: toolInstances.id,
      publishedAsService: toolInstances.publishedAsService,
      serviceAuthMode: toolInstances.serviceAuthMode,
      name: tools.name,
      description: tools.description,
      apiSpec: tools.apiSpec,
      serviceSpec: tools.serviceSpec,
    })
    .from(toolInstances)
    .innerJoin(tools, eq(tools.id, toolInstances.templateId))
    .where(eq(toolInstances.id, id))
    .limit(1)
  if (!instance) return NextResponse.json({ error: 'Instance not found' }, { status: 404 })
  if (!instance.publishedAsService)
    return NextResponse.json({ error: 'Instance not published as service' }, { status: 403 })
  const serviceType =
    instance.serviceSpec && typeof instance.serviceSpec === 'object'
      ? (instance.serviceSpec as { type?: unknown }).type
      : undefined
  if (serviceType !== 'json') {
    return NextResponse.json(
      { error: 'OpenAPI invoke documents are only available for JSON services' },
      { status: 409 }
    )
  }
  const requiresApiKey = instance.serviceAuthMode !== 'anonymous'
  const inputSchema =
    instance.apiSpec && typeof instance.apiSpec === 'object' ? instance.apiSpec : { type: 'object' }
  return NextResponse.json({
    openapi: '3.0.3',
    info: {
      title: instance.name,
      description: instance.description ?? undefined,
      version: '1.0.0',
    },
    paths: {
      [`/api/tools/${id}/invoke`]: {
        post: {
          summary: 'Invoke published tool',
          security: requiresApiKey ? [{ ApiKeyAuth: [] }] : [],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { type: 'object', required: ['input'], properties: { input: inputSchema } },
              },
            },
          },
          responses: {
            '200': { description: 'Invocation result' },
            ...(requiresApiKey ? { '401': { description: 'Invalid API key' } } : {}),
          },
        },
      },
    },
    ...(requiresApiKey
      ? {
          components: {
            securitySchemes: { ApiKeyAuth: { type: 'apiKey', in: 'header', name: 'X-API-Key' } },
          },
        }
      : {}),
  })
}
