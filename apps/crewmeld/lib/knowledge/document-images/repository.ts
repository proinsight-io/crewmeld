import { db, knowledgeDocumentImages } from '@crewmeld/db'
import { and, eq, inArray, max } from 'drizzle-orm'
import { v4 as uuidv4 } from 'uuid'
import type { ImageBindingDecision } from './binding'
import type { ExtractedDocumentImage } from './docx-extractor'

export async function replaceDocumentImages(
  datasetId: string,
  documentId: string,
  images: ExtractedDocumentImage[]
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(knowledgeDocumentImages).where(eq(knowledgeDocumentImages.documentId, documentId))
    if (images.length === 0) return
    await tx.insert(knowledgeDocumentImages).values(
      images.map((image) => ({
        id: uuidv4(),
        datasetId,
        documentId,
        anchorText: image.anchorText,
        sourceCharOffset: image.sourceCharOffset,
        sourceText: image.sourceText,
        mimeType: image.mimeType,
        contentBase64: Buffer.from(image.bytes).toString('base64'),
        sortOrder: image.order,
        boundChunkId: null,
        bindingStatus: 'pending',
        bindingError: null,
        bindingGeneration: 1,
      }))
    )
  })
}

export async function findDocumentImages(documentIds: string[]) {
  if (documentIds.length === 0) return []
  return await db
    .select({
      id: knowledgeDocumentImages.id,
      documentId: knowledgeDocumentImages.documentId,
      boundChunkId: knowledgeDocumentImages.boundChunkId,
      mimeType: knowledgeDocumentImages.mimeType,
      sortOrder: knowledgeDocumentImages.sortOrder,
    })
    .from(knowledgeDocumentImages)
    .where(inArray(knowledgeDocumentImages.documentId, [...new Set(documentIds)]))
}

export async function findBoundDocumentImages(chunkIds: string[]) {
  if (chunkIds.length === 0) return []
  return await db
    .select({
      id: knowledgeDocumentImages.id,
      documentId: knowledgeDocumentImages.documentId,
      boundChunkId: knowledgeDocumentImages.boundChunkId,
      mimeType: knowledgeDocumentImages.mimeType,
      sortOrder: knowledgeDocumentImages.sortOrder,
    })
    .from(knowledgeDocumentImages)
    .where(
      and(
        inArray(knowledgeDocumentImages.boundChunkId, [...new Set(chunkIds)]),
        eq(knowledgeDocumentImages.bindingStatus, 'bound')
      )
    )
}

export async function invalidateDocumentImageBindings(documentId: string): Promise<number> {
  return await db.transaction(async (tx) => {
    const [current] = await tx
      .select({ generation: max(knowledgeDocumentImages.bindingGeneration) })
      .from(knowledgeDocumentImages)
      .where(eq(knowledgeDocumentImages.documentId, documentId))
    if (current?.generation == null) return 0
    const nextGeneration = current.generation + 1
    await tx
      .update(knowledgeDocumentImages)
      .set({
        boundChunkId: null,
        bindingStatus: 'pending',
        bindingError: null,
        bindingGeneration: nextGeneration,
      })
      .where(eq(knowledgeDocumentImages.documentId, documentId))
    return nextGeneration
  })
}

export async function getPendingDocumentImages(documentId: string, generation: number) {
  return await db
    .select({
      id: knowledgeDocumentImages.id,
      sourceCharOffset: knowledgeDocumentImages.sourceCharOffset,
      sourceText: knowledgeDocumentImages.sourceText,
      anchorText: knowledgeDocumentImages.anchorText,
      sortOrder: knowledgeDocumentImages.sortOrder,
    })
    .from(knowledgeDocumentImages)
    .where(
      and(
        eq(knowledgeDocumentImages.documentId, documentId),
        eq(knowledgeDocumentImages.bindingGeneration, generation),
        eq(knowledgeDocumentImages.bindingStatus, 'pending')
      )
    )
}

export async function applyDocumentImageBindings(
  documentId: string,
  generation: number,
  decisions: ImageBindingDecision[]
): Promise<boolean> {
  return await db.transaction(async (tx) => {
    const current = await tx
      .select({ id: knowledgeDocumentImages.id })
      .from(knowledgeDocumentImages)
      .where(
        and(
          eq(knowledgeDocumentImages.documentId, documentId),
          eq(knowledgeDocumentImages.bindingGeneration, generation),
          eq(knowledgeDocumentImages.bindingStatus, 'pending')
        )
      )
    const currentIds = new Set(current.map((row) => row.id))
    if (
      currentIds.size !== decisions.length ||
      decisions.some((decision) => !currentIds.has(decision.imageId))
    ) {
      return false
    }
    for (const decision of decisions) {
      await tx
        .update(knowledgeDocumentImages)
        .set({
          boundChunkId: decision.chunkId,
          bindingStatus: decision.status,
          bindingError: decision.error,
        })
        .where(
          and(
            eq(knowledgeDocumentImages.id, decision.imageId),
            eq(knowledgeDocumentImages.documentId, documentId),
            eq(knowledgeDocumentImages.bindingGeneration, generation)
          )
        )
    }
    return true
  })
}

export async function listPendingImageBindingDocuments() {
  return await db
    .selectDistinct({
      datasetId: knowledgeDocumentImages.datasetId,
      documentId: knowledgeDocumentImages.documentId,
      generation: knowledgeDocumentImages.bindingGeneration,
    })
    .from(knowledgeDocumentImages)
    .where(eq(knowledgeDocumentImages.bindingStatus, 'pending'))
}

export async function findPendingImageBindingGeneration(
  documentId: string
): Promise<number | null> {
  const [pending] = await db
    .select({ generation: max(knowledgeDocumentImages.bindingGeneration) })
    .from(knowledgeDocumentImages)
    .where(
      and(
        eq(knowledgeDocumentImages.documentId, documentId),
        eq(knowledgeDocumentImages.bindingStatus, 'pending')
      )
    )
  return pending?.generation ?? null
}

export async function findDocumentImageById(imageId: string) {
  const [image] = await db
    .select()
    .from(knowledgeDocumentImages)
    .where(eq(knowledgeDocumentImages.id, imageId))
    .limit(1)
  return image ?? null
}

export async function deleteDocumentImages(documentId: string): Promise<void> {
  await db.delete(knowledgeDocumentImages).where(eq(knowledgeDocumentImages.documentId, documentId))
}
