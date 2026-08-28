import { apiErr, apiOk } from '@/lib/api/response'
import { authenticateEmployeeApiKey } from '@/lib/employee-api/auth'

/** Validate an employee API key without creating data. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ employeeId: string }> }
) {
  const { employeeId } = await params
  const auth = await authenticateEmployeeApiKey(request, employeeId)
  if (!auth.ok)
    return apiErr('api.common.unauthorized', {
      status: auth.reason === 'origin_denied' ? 403 : 401,
      extra: { code: auth.reason.toUpperCase() },
    })
  return apiOk({
    employeeId,
    keyId: auth.principal.keyId,
    userId: auth.principal.userId,
    active: true,
  })
}
