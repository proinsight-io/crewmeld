export interface StoredDocumentImageMatch {
  id: string
  documentId: string
  boundChunkId: string | null
  mimeType: string
  sortOrder: number
}

export interface DocumentImageReference {
  id: string
  url: string
  mimeType: string
  order: number
}

/**
 * `publicEmployeeId` routes through the employee-API-key-authenticated public
 * endpoint instead of the admin-session-gated one, for conversations served
 * over the public employee API (no admin session available, e.g. the H5
 * client).
 */
export function buildDocumentImageUrl(imageId: string, publicEmployeeId?: string): string {
  if (publicEmployeeId) {
    return `/api/public/employees/${encodeURIComponent(publicEmployeeId)}/ragflow/document-images/${encodeURIComponent(imageId)}`
  }
  return `/api/employee/ragflow/document-images/${encodeURIComponent(imageId)}`
}

export function attachImagesToChunks<
  T extends { id: string; document_id: string; content: string; images?: DocumentImageReference[] },
>(chunks: T[], images: StoredDocumentImageMatch[], publicEmployeeId?: string): T[] {
  const imagesByChunk = new Map<string, StoredDocumentImageMatch[]>()
  for (const image of images) {
    if (!image.boundChunkId) continue
    const list = imagesByChunk.get(image.boundChunkId) ?? []
    list.push(image)
    imagesByChunk.set(image.boundChunkId, list)
  }

  return chunks.map((chunk) => {
    const matched = (imagesByChunk.get(chunk.id) ?? [])
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((image) => ({
        id: image.id,
        url: buildDocumentImageUrl(image.id, publicEmployeeId),
        mimeType: image.mimeType,
        order: image.sortOrder,
      }))
    return matched.length > 0 ? { ...chunk, images: matched } : chunk
  })
}
