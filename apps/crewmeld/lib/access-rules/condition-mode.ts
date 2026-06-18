/**
 * Mode helpers for an identity-condition slot: a tree is in "named" mode when it
 * is exactly one rule reference, otherwise it is a custom inline tree.
 */

import type { ConditionTree } from '@/lib/identity/condition-tree'
import { isRuleRef } from '@/lib/identity/condition-tree'

/** The referenced rule id when `tree` is a single rule reference, else null. */
export function getRuleRefId(tree: ConditionTree): string | null {
  if (tree.children.length !== 1) return null
  const only = tree.children[0]
  return isRuleRef(only) ? only.ruleRef : null
}

/** Whether `tree` references exactly one named rule. */
export function isNamedMode(tree: ConditionTree): boolean {
  return getRuleRefId(tree) !== null
}

/** Wrap a rule id as a single-reference condition tree. */
export function makeRuleRefTree(id: string): ConditionTree {
  return { op: 'and', children: [{ ruleRef: id }] }
}
