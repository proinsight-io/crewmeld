import { loadPublishedService, proxyPublishedService } from '@/lib/tools/service-gateway'

async function handle(
  request: Request,
  { params }: { params: Promise<{ instanceId: string; path?: string[] }> }
) {
  const { instanceId, path = [] } = await params
  const service = await loadPublishedService(instanceId)
  if (!service)
    return Response.json({ success: false, error: 'Service not found.' }, { status: 404 })
  return proxyPublishedService(request, service, path.join('/'))
}

export const GET = handle
export const POST = handle
export const PUT = handle
export const PATCH = handle
export const DELETE = handle
export const HEAD = handle
export const OPTIONS = handle
