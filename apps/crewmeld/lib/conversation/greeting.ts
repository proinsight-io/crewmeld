import type { ScopeIdentity } from '@/lib/identity/types'
import { getCustomerServiceConfig, renderGreeting } from './customer-service'

interface GreetingUser {
  id: string
  name?: string | null
  email?: string | null
}

/** Render a configured greeting from the conversation owner's identity. */
export function createConversationGreeting(
  employeeConfig: unknown,
  user: GreetingUser,
  identity: ScopeIdentity | null
): string | null {
  const template = getCustomerServiceConfig(employeeConfig).greeting?.trim()
  if (!template) return null
  const raw = (identity?.raw as Record<string, unknown> | undefined) ?? {}
  const values: Record<string, unknown> = {
    ...raw,
    id: user.id,
    userId: user.id,
    name: user.name ?? identity?.profile?.senderName ?? raw.name,
    email: user.email ?? raw.email,
    role: identity?.roles?.[0],
    roles: identity?.roles ?? [],
    positions: identity?.positions ?? [],
    employeeNo: identity?.employeeNo,
    scope: identity?.scope ?? { orgUnitIds: [] },
    raw,
  }
  const rendered = renderGreeting(template, values).trim()
  return rendered || null
}
