/**
 * Neutral identity-condition tree: types + evaluator + field-value resolver.
 *
 * Shared by SOP visibility (allow/hide/deny) and the ontology data access policy
 * (grant gates). Holds ONLY the identity-gate layer — no SOP tri-state and no data
 * row/column logic. Evaluating a tree against an identity yields a boolean.
 */

import type { ScopeIdentity } from '@/lib/identity/types'

/** A leaf condition: an identity field compared against candidate values (OR among values). */
export interface LeafCondition {
  /** Field catalog key (e.g. 'positions') or a dotted identity path (e.g. 'scope.storeIds'). */
  field: string
  /**
   * `equals` — exact match (any actual value equals any candidate).
   * `contains` — substring match (any actual value contains any candidate), for text
   * fields like display names. Note: for id-type fields ({@link ID_FIELDS}) the matcher
   * always uses exact set-membership regardless of this operator.
   */
  operator: 'equals' | 'contains'
  values: string[]
}

/** A reference to a named access rule, resolved at eval time. */
export interface RuleRef {
  ruleRef: string
}

/** A boolean group combining child conditions / sub-groups / rule references. */
export interface ConditionGroup {
  op: 'and' | 'or'
  children: Array<LeafCondition | ConditionGroup | RuleRef>
}

export type ConditionTree = ConditionGroup

/**
 * Fields whose values are ids — matched by exact set membership, never substring,
 * regardless of a condition's `operator`. Any new id-type catalog field MUST be added
 * here so `contains` does not accidentally substring-match ids.
 */
const ID_FIELDS = new Set(['orgUnitIds', 'employeeId', 'leaderId', 'storeIds'])

/** Narrow a tree node to a group. Returns false for a {@link RuleRef} (it has no `op`). */
export function isConditionGroup(
  node: LeafCondition | ConditionGroup | RuleRef,
): node is ConditionGroup {
  return 'op' in node
}

/** Narrow a tree node to a rule reference. */
export function isRuleRef(node: LeafCondition | ConditionGroup | RuleRef): node is RuleRef {
  return 'ruleRef' in node
}

/** Coerce any resolved value to a string[] (nullish → []). */
function toStringList(value: unknown): string[] {
  if (value === null || value === undefined) return []
  if (Array.isArray(value)) return value.filter((v) => v != null).map((v) => String(v))
  return [String(value)]
}

/** Walk a dotted path into an object; undefined if any segment is missing. */
function getByPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj
  for (const seg of path.split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[seg]
  }
  return cur
}

/**
 * Resolve an identity field key (or dotted path) to its string[] value.
 *
 * Dotted keys walk the identity (`scope.storeIds`, `profile.channel`,
 * `raw.attributes.<k>`). Flat keys map known catalog fields; an unknown flat key
 * falls back to `identity.raw[key]`.
 */
export function getIdentityFieldValue(identity: ScopeIdentity, field: string): string[] {
  if (field.includes('.')) return toStringList(getByPath(identity, field))
  switch (field) {
    case 'employeeId':
      return toStringList(identity.employeeId)
    case 'orgUnitIds':
      return toStringList(identity.scope?.orgUnitIds)
    case 'storeIds':
      return toStringList(identity.scope?.storeIds)
    case 'positions':
      return toStringList(identity.positions)
    case 'employeeNo':
      return toStringList(identity.employeeNo)
    case 'leaderId':
      return toStringList(identity.leaderId)
    case 'roles':
      return toStringList(identity.roles)
    case 'name':
      return toStringList(identity.raw?.name)
    case 'email':
      return toStringList(identity.raw?.email)
    case 'mobile':
      return toStringList(identity.raw?.mobile)
    case 'deptNames':
      return toStringList(identity.raw?.deptNames)
    case 'employeeType':
      return toStringList(identity.raw?.employeeType)
    case 'orgUnitCustomIds':
      return toStringList(identity.raw?.orgUnitCustomIds)
    default:
      // Unknown flat key → look it up on the raw channel directory record. The cast is
      // intentional: `raw` carries channel-specific extras (e.g. the `attributes` bag of
      // passthrough custom fields) beyond ChannelUserDetail's declared shape. Prefer a
      // dotted path (`raw.attributes.<k>`) for those; this is the convenience fallback.
      return toStringList(
        identity.raw ? (identity.raw as unknown as Record<string, unknown>)[field] : undefined,
      )
  }
}

/** Evaluate a single leaf condition against an identity. */
function evalLeaf(cond: LeafCondition, identity: ScopeIdentity): boolean {
  if (cond.values.length === 0) return false
  const actual = getIdentityFieldValue(identity, cond.field)
  if (actual.length === 0) return false
  if (cond.operator === 'equals' || ID_FIELDS.has(cond.field)) {
    return actual.some((a) => cond.values.includes(a))
  }
  return actual.some((a) => cond.values.some((v) => a.includes(v)))
}

/** Resolver from a rule id to its condition tree; `undefined` when the rule is unknown. */
export type RuleResolver = (id: string) => ConditionTree | undefined

/**
 * Evaluate any node: a rule reference, a sub-group, or a leaf.
 *
 * Rule references are fail-closed: a missing resolver, an unknown rule, or a
 * reference cycle (id already in `visited`) all yield `false` without throwing.
 */
function evalNode(
  node: LeafCondition | ConditionGroup | RuleRef,
  identity: ScopeIdentity,
  resolveRule: RuleResolver | undefined,
  visited: Set<string>,
): boolean {
  if (isRuleRef(node)) {
    if (!resolveRule || visited.has(node.ruleRef)) return false
    const ref = resolveRule(node.ruleRef)
    if (!ref) return false
    const next = new Set(visited)
    next.add(node.ruleRef)
    return evalGroup(ref, identity, resolveRule, next)
  }
  if (isConditionGroup(node)) return evalGroup(node, identity, resolveRule, visited)
  return evalLeaf(node, identity)
}

/** Evaluate a group: AND = every child true; OR = any child true. Empty group → false. */
function evalGroup(
  group: ConditionGroup,
  identity: ScopeIdentity,
  resolveRule: RuleResolver | undefined,
  visited: Set<string>,
): boolean {
  if (group.children.length === 0) return false
  const results = group.children.map((child) =>
    evalNode(child, identity, resolveRule, visited),
  )
  return group.op === 'and' ? results.every(Boolean) : results.some(Boolean)
}

/**
 * Whether the caller `identity` satisfies the condition `tree`.
 *
 * Pass `resolveRule` to support {@link RuleRef} nodes (named access rules). Without
 * it, any rule reference fails closed. Reference cycles are detected and fail closed.
 */
export function evalConditionTree(
  tree: ConditionTree,
  identity: ScopeIdentity,
  resolveRule?: RuleResolver,
): boolean {
  return evalGroup(tree, identity, resolveRule, new Set<string>())
}
