/**
 * SOP visibility-rule types.
 *
 * A SOP's visibility is gated per bound channel connection. Each connection has
 * one {@link VisibilityGroup} tree (max two levels of nesting). The matcher
 * ({@link resolveSopAccess}) evaluates the tree against the caller's resolved
 * identity. Storage: `sop_definitions.visibility_rules` jsonb column.
 */

/**
 * Tri-state access decision for a SOP relative to a caller.
 *
 * - `allow`: caller may run the SOP (rule matched, or rules absent/disabled).
 * - `hide`: caller has no permission and the SOP is silently withheld (not a tool,
 *   not in the prompt).
 * - `deny`: caller has no permission but the SOP is exposed as a restricted task,
 *   so the LLM can tell the user they lack permission. A program-level safety net
 *   still rejects any actual invocation.
 */
export type SopAccess = 'allow' | 'hide' | 'deny'

/**
 * Comparison operator for a single leaf condition.
 *
 * @invariant For id-typed fields (`orgUnitIds`, `employeeId`, `leaderId`) the
 * matcher always performs set-membership regardless of the stored operator, so
 * `contains` degrades to `equals` for those fields.
 */
export type VisibilityOperator = 'equals' | 'contains'

/** A leaf condition: a field compared against one or more candidate values. */
export interface VisibilityCondition {
  /** Field catalog key, e.g. 'orgUnitIds' | 'employeeNo' | 'positions' | 'email'. */
  field: string
  operator: VisibilityOperator
  /** Candidate values; OR semantics among them. Dept/user store ids, others store text. */
  values: string[]
}

/** A boolean group combining child conditions / sub-groups. */
export interface VisibilityGroup {
  op: 'and' | 'or'
  /** Root group may contain sub-groups; a sub-group may contain only leaf conditions. */
  children: Array<VisibilityCondition | VisibilityGroup>
}

/** Per-connection rule tree (the root of a channel tab). */
export type ChannelRuleTree = VisibilityGroup

/** Full visibility config persisted on a SOP definition. */
export interface SopVisibilityRules {
  /** When false (or rules absent), the SOP is visible to everyone (backward compatible). */
  enabled: boolean
  /**
   * Action when a caller does NOT pass permission — i.e. the rule tree did not
   * match, the caller's connection has no tab, or the identity is unresolved.
   * `hide` silently withholds the SOP; `deny` exposes it as a restricted task so
   * the LLM can tell the user they lack permission (a program-level safety net
   * still rejects any actual call).
   *
   * @remarks This field is optional. Legacy rows written before the
   * `onNoPermission` column was introduced will not have this field; the matcher
   * treats a missing value as `'hide'` (the safe default). Only an explicit
   * `'deny'` value opts into the no-permission message behaviour.
   */
  onNoPermission?: 'hide' | 'deny'
  /** key = systemConnections.id (bound channel instance). */
  channels: Record<string, ChannelRuleTree>
}

/**
 * How a field's value is entered in the UI.
 *
 * @remarks Consumed by the per-channel identity-field catalog
 * (`lib/channels/identity-field-catalog.ts`) and the SOP permission UI.
 * This is an intentional forward declaration, not dead code.
 */
export type IdentityFieldValueSource =
  | 'dept-picker'
  | 'user-picker'
  | 'free-text'
  | 'web-user-picker'
  | 'web-role-picker'

/**
 * A matchable identity field, declared per channel.
 *
 * @remarks Consumed by the per-channel identity-field catalog
 * (`lib/channels/identity-field-catalog.ts`) and the SOP permission UI.
 * This is an intentional forward declaration, not dead code.
 */
export interface IdentityFieldDef {
  key: string
  /** Chinese UI label, e.g. 部门 / 工号 / 职务 / 邮箱. */
  label: string
  valueSource: IdentityFieldValueSource
}

/** Narrow a tree node to a group. */
export function isGroup(node: VisibilityCondition | VisibilityGroup): node is VisibilityGroup {
  return 'op' in node
}
