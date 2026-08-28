import { db, employeeApiKeys } from '@crewmeld/db'
import { and, eq } from 'drizzle-orm'
import { resolveWebIdentity } from '@/lib/identity/web-identity'
import { hashApiKey } from '@/lib/tools/api-key-service'
import { isOriginAllowed } from './origin-policy'

export interface EmployeeApiPrincipal {
  keyId: string
  employeeId: string
  actorId: string
  userId: string | null
}

export type EmployeeApiAuthentication =
  | { ok: true; principal: EmployeeApiPrincipal }
  | { ok: false; reason: 'missing' | 'invalid' | 'origin_denied' }

/** Authenticate a published employee API key and enforce its optional browser-origin allowlist. */
export async function authenticateEmployeeApiKey(
  request: Request,
  employeeId: string
): Promise<EmployeeApiAuthentication> {
  const raw = request.headers.get('x-api-key')
  if (!raw) return { ok: false, reason: 'missing' }
  const [key] = await db
    .select({
      id: employeeApiKeys.id,
      userId: employeeApiKeys.userId,
      allowedOrigins: employeeApiKeys.allowedOrigins,
    })
    .from(employeeApiKeys)
    .where(
      and(
        eq(employeeApiKeys.employeeId, employeeId),
        eq(employeeApiKeys.hashedKey, hashApiKey(raw)),
        eq(employeeApiKeys.active, true)
      )
    )
    .limit(1)
  if (!key) return { ok: false, reason: 'invalid' }
  if (!key.userId || !(await resolveWebIdentity(key.userId))) {
    return { ok: false, reason: 'invalid' }
  }
  if (!isOriginAllowed(request.headers.get('origin'), key.allowedOrigins))
    return { ok: false, reason: 'origin_denied' }
  await db
    .update(employeeApiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(employeeApiKeys.id, key.id))
  return {
    ok: true,
    principal: {
      keyId: key.id,
      employeeId,
      userId: key.userId,
      actorId: key.userId,
    },
  }
}
