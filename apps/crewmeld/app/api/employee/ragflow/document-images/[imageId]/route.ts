import type { NextRequest } from 'next/server'
import { apiAuthErr, apiErr } from '@/lib/api/response'
import { requirePermission } from '@/lib/auth/rbac/check-permission'
import { findDocumentImageById } from '@/lib/knowledge/document-images/repository'

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ imageId: string }> }
) {
  const auth = await requirePermission('knowledge:list')
  if (!auth.authenticated || auth.error) return apiAuthErr(auth)

  const { imageId } = await params
  const image = imageId ? await findDocumentImageById(imageId) : null
  if (!image) return apiErr('api.ragflow.imageFetchFailed', { status: 404 })

  return new Response(Buffer.from(image.contentBase64, 'base64'), {
    headers: {
      'Content-Type': image.mimeType,
      'Cache-Control': 'private, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
