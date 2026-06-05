import { randomUUID } from 'crypto'
import { db } from '@crewmeld/db'
import { toolInstances, tools } from '@crewmeld/db/schema'
import { desc, eq } from 'drizzle-orm'
import type { NextRequest } from 'next/server'
import { apiAuthErr, apiErr, apiOk } from '@/lib/api/response'
import { withAudit } from '@/lib/audit/with-audit'
import { requirePermission } from '@/lib/auth/rbac/check-permission'
import type { SkillPackage } from '@/app/(employee)/skills/types'

/** Map database row to frontend SkillPackage */
function rowToSkill(row: typeof tools.$inferSelect): SkillPackage {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    version: row.version,
    size: row.code ? `${(new Blob([row.code]).size / 1024).toFixed(1)} KB` : '0 KB',
    uploadedAt: row.createdAt.toISOString().slice(0, 10),
    source: row.source as SkillPackage['source'],
    category: row.category ?? undefined,
    author: row.author ?? undefined,
    url: row.url ?? undefined,
    parameters: row.parameters as SkillPackage['parameters'],
    code: row.code ?? undefined,
    presetParams: row.presetParams as SkillPackage['presetParams'],
    language: (row.language as SkillPackage['language']) ?? 'javascript',
    deploy: row.deploy as SkillPackage['deploy'],
    envVars: row.envVars as SkillPackage['envVars'],
    apiDoc: row.apiDoc ?? undefined,
    connectorType: row.connectorType as SkillPackage['connectorType'],
    needsFileMount: row.needsFileMount ?? false,
  }
}

export async function GET() {
  const auth = await requirePermission('skill:list')
  if (!auth.authenticated || auth.error) {
    return apiAuthErr(auth)
  }
  const rows = await db.select().from(tools).orderBy(desc(tools.createdAt))
  return apiOk(null, { extra: { configured: true, skills: rows.map(rowToSkill) } })
}

async function _POST(request: NextRequest) {
  const auth = await requirePermission('skill:create')
  if (!auth.authenticated || auth.error) {
    return apiAuthErr(auth)
  }

  const body = (await request.json()) as { skill: SkillPackage }
  const { skill } = body

  if (!skill?.id || !skill?.name) {
    return apiErr('api.skill.missingFields', { status: 400 })
  }

  const now = new Date()

  const existing = await db.select({ id: tools.id }).from(tools).where(eq(tools.id, skill.id))

  if (existing.length > 0) {
    await db
      .update(tools)
      .set({
        name: skill.name,
        description: skill.description ?? '',
        version: skill.version,
        code: skill.code ?? null,
        parameters: skill.parameters ?? null,
        presetParams: skill.presetParams ?? null,
        category: skill.category ?? null,
        author: skill.author ?? null,
        language: skill.language ?? 'javascript',
        source: skill.source ?? 'installed',
        url: skill.url ?? null,
        deploy: skill.deploy ?? null,
        envVars: skill.envVars ?? null,
        apiDoc: skill.apiDoc ?? null,
        connectorType: skill.connectorType ?? null,
        needsFileMount: skill.needsFileMount ?? false,
        updatedAt: now,
      })
      .where(eq(tools.id, skill.id))
  } else {
    await db.insert(tools).values({
      id: skill.id,
      name: skill.name,
      description: skill.description ?? '',
      version: skill.version,
      code: skill.code ?? null,
      parameters: skill.parameters ?? null,
      presetParams: skill.presetParams ?? null,
      category: skill.category ?? null,
      author: skill.author ?? null,
      language: skill.language ?? 'javascript',
      source: skill.source ?? 'installed',
      url: skill.url ?? null,
      deploy: null,
      envVars: skill.envVars ?? null,
      apiDoc: skill.apiDoc ?? null,
      connectorType: skill.connectorType ?? null,
      needsFileMount: skill.needsFileMount ?? false,
      createdBy: auth.userId!,
      createdAt: now,
      updatedAt: now,
    })

    if (skill.code) {
      await db.insert(toolInstances).values({
        id: `inst-${randomUUID()}`,
        templateId: skill.id,
        name: skill.name,
        presetParams: skill.presetParams ?? null,
        envVars: skill.envVars ?? null,
        createdBy: auth.userId!,
        createdAt: now,
        updatedAt: now,
      })
    }
  }

  return apiOk(null)
}

export const POST = withAudit(_POST)
