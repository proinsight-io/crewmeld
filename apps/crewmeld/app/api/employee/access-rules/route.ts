import { db } from '@crewmeld/db'
import { sopDefinitions } from '@crewmeld/db/schema'
import { createLogger } from '@crewmeld/logger'
import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { deleteAccessRule, listAccessRules, putAccessRule } from '@/lib/access-rules/store'
import { apiAuthErr, apiErr, apiOk } from '@/lib/api/response'
import { withAudit } from '@/lib/audit/with-audit'
import { requirePermission } from '@/lib/auth/rbac/check-permission'
import type { ConditionTree } from '@/lib/identity/condition-tree'

const logger = createLogger('AccessRulesRoute')

const leafSchema = z.object({
  field: z.string().min(1),
  operator: z.enum(['equals', 'contains']),
  values: z.array(z.string()),
})

const ruleRefSchema = z.object({ ruleRef: z.string().min(1) })

type TreeNode =
  | z.infer<typeof leafSchema>
  | z.infer<typeof ruleRefSchema>
  | { op: 'and' | 'or'; children: TreeNode[] }

const groupSchema: z.ZodType<{ op: 'and' | 'or'; children: TreeNode[] }> = z.lazy(() =>
  z.object({
    op: z.enum(['and', 'or']),
    children: z.array(z.union([leafSchema, ruleRefSchema, groupSchema])),
  })
)

const ruleBodySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  tree: groupSchema,
})

/**
 * Whether a loosely-typed jsonb condition-tree node (or any of its descendants)
 * references the access rule `ruleId`.
 *
 * The jsonb is not statically typed, so this narrows defensively: a node is a
 * rule reference when it carries a `ruleRef` string, a group when it carries a
 * `children` array, and anything else (leaf / malformed) cannot reference a rule.
 */
function treeReferencesRule(node: unknown, ruleId: string): boolean {
  if (node === null || typeof node !== 'object') return false
  const obj = node as Record<string, unknown>
  if (typeof obj.ruleRef === 'string') return obj.ruleRef === ruleId
  if (Array.isArray(obj.children)) {
    return obj.children.some((child) => treeReferencesRule(child, ruleId))
  }
  return false
}

/** A party that references an access rule (SOP definition). */
interface RuleReference {
  id: string
  name: string
}

/**
 * Collect every party that references the access rule `ruleId`.
 *
 * Scans `sop_definitions.visibility_rules` — each SOP holds per-connection
 * condition trees under `channels`, any of which may contain a {@link RuleRef}.
 *
 * A reference causes the guard to refuse deletion (HTTP 409).
 */
async function findRuleReferences(ruleId: string): Promise<RuleReference[]> {
  const rows = await db
    .select({
      id: sopDefinitions.id,
      name: sopDefinitions.name,
      visibilityRules: sopDefinitions.visibilityRules,
    })
    .from(sopDefinitions)

  const references: RuleReference[] = []
  for (const row of rows) {
    const rules = row.visibilityRules
    if (rules === null || typeof rules !== 'object') continue
    const channels = (rules as Record<string, unknown>).channels
    if (channels === null || typeof channels !== 'object') continue
    const referenced = Object.values(channels as Record<string, unknown>).some((tree) =>
      treeReferencesRule(tree, ruleId)
    )
    if (referenced) references.push({ id: row.id, name: row.name })
  }

  return references
}

/**
 * GET /api/employee/access-rules — list all named access rules.
 */
export async function GET() {
  try {
    const auth = await requirePermission('knowledge:list')
    if (!auth.authenticated || auth.error) return apiAuthErr(auth)

    return apiOk(await listAccessRules())
  } catch (error) {
    logger.error('access-rules GET failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    return apiErr('api.accessRules.readFailed', { status: 500 })
  }
}

/**
 * PUT /api/employee/access-rules — upsert a named access rule.
 *
 * Body (JSON): `{ id, name, description?, tree }` where `tree` is a recursive
 * condition group whose children may be leaf conditions, sub-groups, or rule
 * references (`{ ruleRef }`).
 */
async function _PUT(request: NextRequest) {
  try {
    const auth = await requirePermission('knowledge:edit')
    if (!auth.authenticated || auth.error) return apiAuthErr(auth)

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return apiErr('api.accessRules.invalidBody', { status: 400 })
    }

    const parsed = ruleBodySchema.safeParse(body)
    if (!parsed.success) return apiErr('api.accessRules.invalidRule', { status: 400 })

    const { id, name, description, tree } = parsed.data
    await putAccessRule({
      id,
      name,
      ...(description !== undefined ? { description } : {}),
      tree: tree as ConditionTree,
    })
    return apiOk({ id })
  } catch (error) {
    logger.error('access-rules PUT failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    return apiErr('api.accessRules.writeFailed', { status: 500 })
  }
}

/**
 * DELETE /api/employee/access-rules?id= — delete a named access rule.
 *
 * Refuses deletion (409) when the rule is still referenced by any SOP
 * visibility tree, returning all referencing parties so the caller can
 * resolve them first.
 */
async function _DELETE(request: NextRequest) {
  try {
    const auth = await requirePermission('knowledge:edit')
    if (!auth.authenticated || auth.error) return apiAuthErr(auth)

    const id = new URL(request.url).searchParams.get('id')
    if (!id) return apiErr('api.accessRules.missingId', { status: 400 })

    const references = await findRuleReferences(id)
    if (references.length > 0) {
      return apiErr('api.accessRules.inUse', { status: 409, extra: { references } })
    }

    await deleteAccessRule(id)
    return apiOk({ id })
  } catch (error) {
    logger.error('access-rules DELETE failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    return apiErr('api.accessRules.deleteFailed', { status: 500 })
  }
}

export const PUT = withAudit(_PUT)
export const DELETE = withAudit(_DELETE)
