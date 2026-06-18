import type { ScopeIdentity } from './types'

/**
 * Whether a caller resolved to a real org/employee scope, as opposed to a
 * profile-only IM identity.
 *
 * Since {@link ScopeIdentity} now always carries an IM-base `profile` for any
 * real inbound message (including anonymous / web callers that map to no
 * internal employee), mere identity presence no longer implies the caller may
 * read scoped business data. Scoped-data access must gate on this predicate
 * so a profile-only caller stays fail-closed — even
 * though forwardIdentity still forwards their IM profile to a tool backend.
 *
 * A caller resolves scope when ANY of these is present: org units, store ids,
 * employee number, or job positions. `storeIds` counts on its own because a
 * store-level scope is a real, clampable scope even when the channel supplied no
 * department/org units (e.g. storeIds sourced from the datasource while
 * orgUnitIds is channel-sourced and empty).
 */
export function hasResolvedScope(identity: ScopeIdentity | undefined): boolean {
  if (!identity) return false
  return (
    identity.scope.orgUnitIds.length > 0 ||
    (identity.scope.storeIds?.length ?? 0) > 0 ||
    !!identity.employeeNo ||
    identity.positions.length > 0
  )
}
