/**
 * Pure, immutable edits on a VisibilityGroup tree. `path` is an array of child
 * indices from the root group. Enforces the two-level nesting cap: groups may be
 * added only at the root (path length 0).
 */

import { isRuleRef } from '@/lib/identity/condition-tree'
import type { VisibilityCondition, VisibilityGroup } from '@/lib/sop/visibility-types'
import { isGroup } from '@/lib/sop/visibility-types'

export function emptyTree(): VisibilityGroup {
  return { op: 'and', children: [] }
}

/** Groups may be nested only one level deep → only the root accepts sub-groups. */
export function canAddGroup(path: number[]): boolean {
  return path.length === 0
}

function newCondition(): VisibilityCondition {
  return { field: 'positions', operator: 'equals', values: [] }
}

function mapGroupAtPath(
  root: VisibilityGroup,
  path: number[],
  fn: (g: VisibilityGroup) => VisibilityGroup
): VisibilityGroup {
  if (path.length === 0) return fn(root)
  const [head, ...rest] = path
  const child = root.children[head]
  if (!child || !isGroup(child)) return root
  const updated = mapGroupAtPath(child as VisibilityGroup, rest, fn)
  const children = root.children.slice()
  children[head] = updated
  return { ...root, children }
}

export function addCondition(root: VisibilityGroup, path: number[]): VisibilityGroup {
  return mapGroupAtPath(root, path, (g) => ({ ...g, children: [...g.children, newCondition()] }))
}

export function addGroup(root: VisibilityGroup, path: number[]): VisibilityGroup {
  if (!canAddGroup(path)) return root
  return mapGroupAtPath(root, path, (g) => ({
    ...g,
    children: [...g.children, { op: 'and', children: [] } as VisibilityGroup],
  }))
}

export function toggleOp(root: VisibilityGroup, path: number[]): VisibilityGroup {
  return mapGroupAtPath(root, path, (g) => ({ ...g, op: g.op === 'and' ? 'or' : 'and' }))
}

/** Remove the child at `path` (last index = position inside its parent group). */
export function removeAt(root: VisibilityGroup, path: number[]): VisibilityGroup {
  if (path.length === 0) return root
  const parentPath = path.slice(0, -1)
  const idx = path[path.length - 1]
  return mapGroupAtPath(root, parentPath, (g) => ({
    ...g,
    children: g.children.filter((_, i) => i !== idx),
  }))
}

/** Update a leaf condition at `path` in place. */
export function updateCondition(
  root: VisibilityGroup,
  path: number[],
  patch: Partial<VisibilityCondition>
): VisibilityGroup {
  const parentPath = path.slice(0, -1)
  const idx = path[path.length - 1]
  return mapGroupAtPath(root, parentPath, (g) => {
    const children = g.children.slice()
    const target = children[idx]
    if (target && !isGroup(target) && !isRuleRef(target)) children[idx] = { ...target, ...patch }
    return { ...g, children }
  })
}
