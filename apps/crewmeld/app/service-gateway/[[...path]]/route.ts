import { proxyPublishedService, resolvePublishedServiceByDomain } from '@/lib/tools/service-gateway'

async function handle(request: Request, { params }: { params: Promise<{ path?: string[] }> }) {
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? ''
  const service = await resolvePublishedServiceByDomain(host)
  if (!service)
    return Response.json({ success: false, error: 'Service domain not found.' }, { status: 404 })
  const { path = [] } = await params
  return proxyPublishedService(request, service, path.join('/'))
}

export const GET = handle
export const POST = handle
export const PUT = handle
export const PATCH = handle
export const DELETE = handle
export const HEAD = handle
export const OPTIONS = handle
