import { db, toolInstances, toolServiceReplicas, tools } from '@crewmeld/db'
import { and, asc, eq, ne } from 'drizzle-orm'
import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { apiAuthErr, apiErr, apiOk } from '@/lib/api/response'
import { withAudit } from '@/lib/audit/with-audit'
import { requirePermission } from '@/lib/auth/rbac/check-permission'
import { buildServicePublicUrl, getServicePublicBaseUrl } from '@/lib/core/utils/urls'
import { MAX_SERVICE_REPLICAS, MIN_SERVICE_REPLICAS } from '@/lib/tools/service-deployment-manager'

const domainPattern = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/

const patchSchema = z
  .object({
    publishedAsService: z.boolean().optional(),
    authMode: z.enum(['api-key', 'anonymous']).optional(),
    visibility: z.enum(['internal', 'public']).optional(),
    customDomain: z.string().trim().toLowerCase().max(253).nullable().optional(),
    desiredReplicas: z
      .number()
      .int()
      .min(MIN_SERVICE_REPLICAS)
      .max(MAX_SERVICE_REPLICAS)
      .optional(),
  })
  .refine(
    (value) =>
      value.customDomain === undefined ||
      value.customDomain === null ||
      value.customDomain === '' ||
      domainPattern.test(value.customDomain),
    { message: 'Invalid custom domain.', path: ['customDomain'] }
  )

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requirePermission('skill:list')
  if (!auth.authenticated || auth.error) return apiAuthErr(auth)
  const { id } = await params

  const [instance] = await db
    .select({
      id: toolInstances.id,
      publishedAsService: toolInstances.publishedAsService,
      serviceAuthMode: toolInstances.serviceAuthMode,
      serviceVisibility: toolInstances.serviceVisibility,
      serviceDomain: toolInstances.serviceDomain,
      desiredReplicas: toolInstances.desiredReplicas,
      deploy: toolInstances.deploy,
      kind: tools.kind,
      serviceSpec: tools.serviceSpec,
    })
    .from(toolInstances)
    .innerJoin(tools, eq(tools.id, toolInstances.templateId))
    .where(eq(toolInstances.id, id))
    .limit(1)
  if (!instance) return apiErr('api.skill.instanceNotFound', { status: 404 })

  const replicas = await db
    .select({
      id: toolServiceReplicas.id,
      ordinal: toolServiceReplicas.ordinal,
      name: toolServiceReplicas.name,
      status: toolServiceReplicas.status,
      errorMessage: toolServiceReplicas.errorMessage,
    })
    .from(toolServiceReplicas)
    .where(eq(toolServiceReplicas.instanceId, id))
    .orderBy(asc(toolServiceReplicas.ordinal))

  return apiOk(null, {
    extra: {
      service: { ...instance, replicas },
      sharedPublicUrl: buildServicePublicUrl(getServicePublicBaseUrl(), id),
    },
  })
}

async function _PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requirePermission('skill:edit')
  if (!auth.authenticated || auth.error) return apiAuthErr(auth)
  const parsed = patchSchema.safeParse(await request.json())
  if (!parsed.success) {
    return apiErr('api.common.badRequest', {
      status: 400,
      extra: { detail: parsed.error.issues[0]?.message },
    })
  }

  const { id } = await params
  const [existing] = await db
    .select({ id: toolInstances.id, kind: tools.kind })
    .from(toolInstances)
    .innerJoin(tools, eq(tools.id, toolInstances.templateId))
    .where(eq(toolInstances.id, id))
    .limit(1)
  if (!existing) return apiErr('api.skill.instanceNotFound', { status: 404 })

  const value = parsed.data
  if (
    value.desiredReplicas !== undefined &&
    existing.kind !== 'service' &&
    value.desiredReplicas !== 1
  ) {
    return apiErr('api.common.badRequest', {
      status: 400,
      extra: { detail: 'Only service tools support multiple replicas.' },
    })
  }

  const customDomain = value.customDomain || null
  if (customDomain) {
    const [collision] = await db
      .select({ id: toolInstances.id })
      .from(toolInstances)
      .where(and(eq(toolInstances.serviceDomain, customDomain), ne(toolInstances.id, id)))
      .limit(1)
    if (collision) {
      return apiErr('api.common.badRequest', {
        status: 409,
        extra: { detail: 'Custom domain is already bound to another service.' },
      })
    }
  }

  const updates: Partial<typeof toolInstances.$inferInsert> = { updatedAt: new Date() }
  if (value.publishedAsService !== undefined) {
    updates.publishedAsService = value.publishedAsService
  }
  if (value.authMode !== undefined) updates.serviceAuthMode = value.authMode
  if (value.visibility !== undefined) updates.serviceVisibility = value.visibility
  if (value.customDomain !== undefined) updates.serviceDomain = customDomain
  if (value.desiredReplicas !== undefined) updates.desiredReplicas = value.desiredReplicas

  await db.update(toolInstances).set(updates).where(eq(toolInstances.id, id))
  return apiOk(null, {
    extra: {
      service: {
        publishedAsService: value.publishedAsService,
        serviceAuthMode: value.authMode,
        serviceVisibility: value.visibility,
        serviceDomain: customDomain,
        desiredReplicas: value.desiredReplicas,
      },
    },
  })
}

export const PATCH = withAudit(_PATCH)
