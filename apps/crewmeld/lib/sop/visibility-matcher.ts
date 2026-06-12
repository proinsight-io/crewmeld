/**
 * Pure SOP access matcher — decides a SOP's tri-state access for a caller, fully
 * program-driven (never an LLM). Consumed by buildWorkflowToolConfigs so a hidden
 * SOP enters neither the LLM tool list nor the system prompt, while a denied SOP
 * is surfaced as a restricted task.
 */

import type { ScopeIdentity } from '@/lib/identity/types'
import type {
  SopAccess,
  SopVisibilityRules,
  VisibilityCondition,
  VisibilityGroup,
} from './visibility-types'
import { isGroup } from './visibility-types'

/** Fields whose values are ids — matched by set membership, never substring. */
const ID_FIELDS = new Set(['orgUnitIds', 'employeeId', 'leaderId'])

/**
 * Resolve the tri-state access a caller (`identity` arriving on `connectionId`)
 * has to a SOP guarded by `rules`.
 *
 * - rules absent / `enabled=false` → `allow` (legacy SOPs unaffected).
 * - connection has a tab AND identity resolved → matched ? `allow` : `onNoPermission`.
 * - otherwise (no tab, or no identity) → `onNoPermission` (`hide` or `deny`).
 */
export function resolveSopAccess(
  rules: SopVisibilityRules | null | undefined,
  identity: ScopeIdentity | null | undefined,
  connectionId: string | null | undefined
): SopAccess {
  if (!rules || !rules.enabled) return 'allow'
  const tree = connectionId ? rules.channels[connectionId] : undefined
  // Legacy/absent onNoPermission (undefined) falls back to the safe 'hide' default;
  // only an explicit 'deny' opts into the no-permission message.
  const noPerm: SopAccess = rules.onNoPermission === 'deny' ? 'deny' : 'hide'
  if (!tree || !identity) return noPerm
  return evaluateGroup(tree, identity) ? 'allow' : noPerm
}

function evaluateGroup(group: VisibilityGroup, identity: ScopeIdentity): boolean {
  if (group.children.length === 0) return false
  const results = group.children.map((child) =>
    isGroup(child) ? evaluateGroup(child, identity) : evaluateCondition(child, identity)
  )
  return group.op === 'and' ? results.every(Boolean) : results.some(Boolean)
}

function evaluateCondition(cond: VisibilityCondition, identity: ScopeIdentity): boolean {
  if (cond.values.length === 0) return false
  const actual = getFieldValue(identity, cond.field)
  const actualList = toStringList(actual)
  if (actualList.length === 0) return false

  if (cond.operator === 'equals' || ID_FIELDS.has(cond.field)) {
    // exact / set-membership: any actual equals any candidate value
    return actualList.some((a) => cond.values.includes(a))
  }
  // contains on text: any actual contains any candidate substring
  return actualList.some((a) => cond.values.some((v) => a.includes(v)))
}

/** Resolve a catalog field key to its value on the enriched identity. */
function getFieldValue(identity: ScopeIdentity, field: string): unknown {
  switch (field) {
    case 'employeeId':
      return identity.employeeId
    case 'orgUnitIds':
      return identity.scope?.orgUnitIds
    case 'positions':
      return identity.positions
    case 'employeeNo':
      return identity.employeeNo
    case 'leaderId':
      return identity.leaderId
    case 'roles':
      return identity.roles
    case 'name':
      return identity.raw?.name
    case 'email':
      return identity.raw?.email
    case 'mobile':
      return identity.raw?.mobile
    case 'deptNames':
      return identity.raw?.deptNames
    case 'employeeType':
      return identity.raw?.employeeType
    default:
      return undefined
  }
}

function toStringList(value: unknown): string[] {
  if (value == null) return []
  if (Array.isArray(value)) return value.filter((v) => v != null).map((v) => String(v))
  return [String(value)]
}
