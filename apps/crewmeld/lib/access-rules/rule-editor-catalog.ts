/**
 * Build the channel-agnostic field catalog for the named-rule editor.
 *
 * Named rules are global, so only tenant-wide value sources are offered: platform
 * RBAC roles (`roles`) and platform users (`employeeId`) keep their pickers; every
 * normalized channel field falls back to free-text (channel-bound dept/user
 * pickers need a `connectionId` and are intentionally absent here). When a unified
 * field already carries one of the special keys, the unified entry wins (free-text)
 * and the special is not added — the field map cannot supply a picker.
 */

import type { IdentityFieldDef, IdentityFieldValueSource } from '@/lib/sop/visibility-types'

interface UnifiedField {
  key: string
  label: string
}

interface SpecialLabels {
  roles: string
  employeeId: string
}

export function buildRuleEditorCatalog(
  unifiedFields: UnifiedField[],
  labels: SpecialLabels
): IdentityFieldDef[] {
  const fromUnified: IdentityFieldDef[] = unifiedFields.map((f) => ({
    key: f.key,
    label: f.label,
    valueSource: 'free-text',
  }))
  const seen = new Set(fromUnified.map((f) => f.key))

  const specials: Array<[string, IdentityFieldValueSource]> = [
    ['roles', 'web-role-picker'],
    ['employeeId', 'web-user-picker'],
  ]
  const prepended: IdentityFieldDef[] = specials
    .filter(([key]) => !seen.has(key))
    .map(([key, valueSource]) => ({
      key,
      label: key === 'roles' ? labels.roles : labels.employeeId,
      valueSource,
    }))

  return [...prepended, ...fromUnified]
}
