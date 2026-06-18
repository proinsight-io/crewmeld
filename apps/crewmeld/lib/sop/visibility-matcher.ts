/**
 * Pure SOP access matcher — decides a SOP's tri-state access for a caller, fully
 * program-driven (never an LLM). Consumed by buildWorkflowToolConfigs so a hidden
 * SOP enters neither the LLM tool list nor the system prompt, while a denied SOP
 * is surfaced as a restricted task.
 *
 * Tree evaluation + identity field resolution are delegated to the shared
 * condition-tree core; this module keeps only the SOP-specific tri-state logic.
 */

import type { ConditionTree, RuleResolver } from '@/lib/identity/condition-tree'
import { evalConditionTree } from '@/lib/identity/condition-tree'
import type { ScopeIdentity } from '@/lib/identity/types'
import type { SopAccess, SopVisibilityRules } from './visibility-types'

/** Legacy shape: visibility used to be keyed per channel connection. */
interface LegacyChanneledRules {
  channels?: Record<string, ConditionTree>
}

/**
 * Resolve the single channel-agnostic visibility tree. Prefers the new `tree`
 * field; falls back to OR-merging legacy per-channel trees so configs written
 * before the channel-agnostic migration keep working (lazy migration).
 */
function resolveVisibilityTree(rules: SopVisibilityRules): ConditionTree | undefined {
  if (rules.tree) return rules.tree
  const legacy = (rules as SopVisibilityRules & LegacyChanneledRules).channels
  const trees = legacy ? Object.values(legacy) : []
  if (trees.length === 0) return undefined
  return { op: 'or', children: trees }
}

/**
 * Resolve the tri-state access a caller (`identity`) has to a SOP guarded by `rules`.
 *
 * - rules absent / `enabled=false` → `allow` (legacy SOPs unaffected).
 * - tree present AND identity resolved → matched ? `allow` : `onNoPermission`.
 * - otherwise (no tree, or no identity) → `onNoPermission` (`hide` or `deny`).
 *
 * Named access-rule references (`{ ruleRef }` nodes) embedded in the tree are
 * resolved live via `resolveRule`, evaluated at decision time rather than baked in.
 * When `resolveRule` is omitted (or a referenced rule is missing, or a reference
 * cycle is detected), the reference fails closed to `false` — inherited from the
 * shared condition-tree core — so the caller is denied/hidden rather than wrongly
 * allowed. Trees without rule references are unaffected.
 *
 * Legacy configs that stored rules keyed by channel connection id (`channels` map)
 * are automatically OR-merged into a single tree for backward compatibility.
 */
export function resolveSopAccess(
  rules: SopVisibilityRules | null | undefined,
  identity: ScopeIdentity | null | undefined,
  resolveRule?: RuleResolver
): SopAccess {
  if (!rules || !rules.enabled) return 'allow'
  const tree = resolveVisibilityTree(rules)
  const noPerm: SopAccess = rules.onNoPermission === 'deny' ? 'deny' : 'hide'
  if (!tree || !identity) return noPerm
  return evalConditionTree(tree, identity, resolveRule) ? 'allow' : noPerm
}
