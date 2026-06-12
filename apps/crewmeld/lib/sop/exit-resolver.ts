import type { ScopeIdentity } from '@/lib/identity/types'
import type { NodeExecutionResult, SopCondition, SopExit, SopNode } from '@/types/sop'

/**
 * Pull the caller's injected identity out of an execution's triggerData._meta.
 *
 * Returns undefined when the SOP was not triggered from an IM channel or no
 * identity could be resolved, so identity-type conditions then evaluate falsy.
 */
export function extractIdentityFromTriggerData(
  triggerData: Record<string, unknown> | undefined
): ScopeIdentity | undefined {
  const meta = triggerData?._meta as Record<string, unknown> | undefined
  return meta?.identity as ScopeIdentity | undefined
}

/**
 * Exit resolution algorithm (whitepaper §8.4.4)
 *
 * Priority:
 * 1. Conditional exit match — iterate in definition order, first match wins (normal exits only)
 * 2. Default exit fallback — condition.type = 'always' or no condition (normal exits only)
 * 3. Endpoint determination — no match -> return null (SOP endpoint)
 *
 * Note: error exits (type='error') do not participate in normal exit evaluation, handled separately by resolveErrorExit.
 *
 * @returns matched exit's exitId + targetNodeId, or null for endpoint
 */
export function evaluateExits(
  node: SopNode,
  executionResult: NodeExecutionResult,
  identity?: ScopeIdentity
): { exitId: string; targetNodeId: string | null } | null {
  // Filter out error exits, only evaluate normal exits
  const normalExits = node.exits.filter((e) => e.type !== 'error')
  if (normalExits.length === 0) return null

  let defaultExit: SopExit | undefined

  for (const exit of normalExits) {
    if (!exit.condition || exit.condition.type === 'always') {
      defaultExit = defaultExit ?? exit
      continue
    }

    if (evaluateCondition(exit.condition, executionResult, identity)) {
      return { exitId: exit.id, targetNodeId: exit.targetNodeId }
    }
  }

  if (defaultExit) {
    return { exitId: defaultExit.id, targetNodeId: defaultExit.targetNodeId }
  }

  return null
}

/**
 * Find the node's error exit (type='error')
 *
 * Called by engine after retries exhausted:
 * - Has error exit and connected -> return exit info, engine routes to target node
 * - Has error exit but not connected (targetNodeId=null) -> return null, engine terminates SOP
 * - No error exit -> return null, engine terminates SOP
 */
export function resolveErrorExit(
  node: SopNode
): { exitId: string; targetNodeId: string | null } | null {
  const errorExit = node.exits.find((e) => e.type === 'error')
  if (!errorExit) return null
  // Error exit not connected to downstream node -> treat as termination
  if (!errorExit.targetNodeId) return null
  return { exitId: errorExit.id, targetNodeId: errorExit.targetNodeId }
}

/**
 * Condition evaluation
 */
export function evaluateCondition(
  condition: SopCondition,
  result: NodeExecutionResult,
  identity?: ScopeIdentity
): boolean {
  switch (condition.type) {
    case 'approval_result':
      return compareValue(result.output?.decision, condition.operator ?? 'eq', condition.value)

    case 'workflow_output': {
      const actual = getNestedValue(result.output, condition.field ?? '')
      return compareValue(actual, condition.operator ?? 'eq', condition.value)
    }

    case 'variable': {
      // Gateway node specific: compare from _gatewayValue (gateway evaluation result)
      const actual =
        result.output?._gatewayValue ?? getNestedValue(result.output, condition.field ?? '')
      return compareValue(actual, condition.operator ?? 'eq', condition.value)
    }

    case 'identity': {
      // Branch on the caller's injected identity (e.g. positions contains "店长").
      const actual = getIdentityField(identity, condition.field ?? '')
      return compareIdentityValue(actual, condition.operator ?? 'contains', condition.value)
    }

    case 'always':
      return true

    default:
      return false
  }
}

/**
 * Resolve an identity field for an `identity`-type condition.
 *
 * Recognized fields: positions/position (job titles), leaderId, orgUnitIds,
 * employeeId. Anything else falls back to a dot-path lookup into the identity.
 */
function getIdentityField(identity: ScopeIdentity | undefined, field: string): unknown {
  if (!identity) return undefined
  switch (field) {
    case 'position':
    case 'positions':
      return identity.positions
    case 'leaderId':
      return identity.leaderId
    case 'orgUnitId':
    case 'orgUnitIds':
      return identity.scope?.orgUnitIds
    case 'employeeId':
      return identity.employeeId
    case 'employeeNo':
      return identity.employeeNo
    default:
      return getNestedValue(identity, field)
  }
}

/**
 * Compare an identity field value. Array fields (positions, orgUnitIds) are
 * matched by membership, so `positions contains 店长` means "any position
 * equals 店长"; `neq` means "no member equals the value".
 */
function compareIdentityValue(actual: unknown, operator: string, expected: unknown): boolean {
  if (Array.isArray(actual)) {
    const hasMatch = actual.some((item) => compareValue(item, 'eq', expected))
    return operator === 'neq' ? !hasMatch : hasMatch
  }
  return compareValue(actual, operator, expected)
}

/**
 * General comparison function (supports boolean↔string loose comparison)
 */
export function compareValue(actual: unknown, operator: string, expected: unknown): boolean {
  // Loose type alignment: boolean ↔ string / number ↔ string
  const [a, e] = looseAlign(actual, expected)

  switch (operator) {
    case 'eq':
      return a === e
    case 'neq':
      return a !== e
    case 'gt':
      return Number(a) > Number(e)
    case 'lt':
      return Number(a) < Number(e)
    case 'contains':
      return typeof a === 'string' && typeof e === 'string' && a.includes(e)
    default:
      return false
  }
}

/**
 * Loose type alignment — make true/'true'/1 comparably equivalent
 */
function looseAlign(a: unknown, b: unknown): [unknown, unknown] {
  if (typeof a === typeof b) return [a, b]
  // boolean ↔ other
  if (typeof a === 'boolean') return [a, toBool(b)]
  if (typeof b === 'boolean') return [toBool(a), b]
  // number ↔ string
  if (typeof a === 'number' && typeof b === 'string') return [String(a), b]
  if (typeof a === 'string' && typeof b === 'number') return [a, String(b)]
  return [a, b]
}

function toBool(v: unknown): boolean {
  if (typeof v === 'boolean') return v
  if (typeof v === 'string') return v.toLowerCase() === 'true' || v === '1'
  if (typeof v === 'number') return v !== 0
  return !!v
}

/**
 * Dot-path value extraction: 'a.b.c' -> obj.a.b.c
 */
export function getNestedValue(obj: unknown, path: string): unknown {
  if (!path) return obj
  return path
    .split('.')
    .reduce<unknown>(
      (acc, key) =>
        acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[key] : undefined,
      obj
    )
}
