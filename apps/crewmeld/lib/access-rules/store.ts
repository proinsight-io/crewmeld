import { db } from '@crewmeld/db'
import { accessRules } from '@crewmeld/db/schema'
import { eq } from 'drizzle-orm'
import type { ConditionTree } from '@/lib/identity/condition-tree'

/** A named, reusable access rule: an identity-condition tree addressable by id. */
export interface AccessRule {
  id: string
  name: string
  description?: string
  tree: ConditionTree
}

/** Map a db row's nullable `description` to the optional interface shape. */
function toAccessRule(row: {
  id: string
  name: string
  description: string | null
  tree: unknown
}): AccessRule {
  const rule: AccessRule = { id: row.id, name: row.name, tree: row.tree as ConditionTree }
  if (row.description !== null) rule.description = row.description
  return rule
}

/** List all access rules. */
export async function listAccessRules(): Promise<AccessRule[]> {
  const rows = await db
    .select({
      id: accessRules.id,
      name: accessRules.name,
      description: accessRules.description,
      tree: accessRules.tree,
    })
    .from(accessRules)
  return rows.map(toAccessRule)
}

/** Read a single access rule by id, or null when none exists. */
export async function getAccessRule(id: string): Promise<AccessRule | null> {
  const rows = await db
    .select({
      id: accessRules.id,
      name: accessRules.name,
      description: accessRules.description,
      tree: accessRules.tree,
    })
    .from(accessRules)
    .where(eq(accessRules.id, id))
    .limit(1)
  const row = rows[0]
  return row ? toAccessRule(row) : null
}

/**
 * Upsert an access rule (idempotent by id). The `updatedAt` column is refreshed
 * automatically by the drizzle `$onUpdate` hook, but we also set it explicitly
 * in the conflict update so the column changes even when the hook is not invoked.
 */
export async function putAccessRule(rule: AccessRule): Promise<void> {
  await db
    .insert(accessRules)
    .values({
      id: rule.id,
      name: rule.name,
      description: rule.description ?? null,
      tree: rule.tree,
    })
    .onConflictDoUpdate({
      target: accessRules.id,
      set: {
        name: rule.name,
        description: rule.description ?? null,
        tree: rule.tree,
        updatedAt: new Date(),
      },
    })
}

/** Delete an access rule by id (no-op when absent). */
export async function deleteAccessRule(id: string): Promise<void> {
  await db.delete(accessRules).where(eq(accessRules.id, id))
}

/**
 * Load all rules once into a synchronous resolver suitable for
 * `evalConditionTree`. Returns `(id) => tree | undefined`, hitting the
 * snapshot taken at load time.
 */
export async function loadRuleResolver(): Promise<(id: string) => ConditionTree | undefined> {
  const rows = await db.select({ id: accessRules.id, tree: accessRules.tree }).from(accessRules)
  const m = new Map<string, ConditionTree>(rows.map((r) => [r.id, r.tree as ConditionTree]))
  return (id: string) => m.get(id)
}
