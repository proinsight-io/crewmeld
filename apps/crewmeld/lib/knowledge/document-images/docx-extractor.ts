import JSZip from 'jszip'

const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const MAX_DOCUMENT_IMAGE_BYTES = 20 * 1024 * 1024

const MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}

export interface ExtractedDocumentImage {
  anchorText: string
  sourceCharOffset: number
  sourceText: string
  fileName: string
  mimeType: string
  bytes: Uint8Array
  order: number
}

function decodeXml(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function relationshipTargets(xml: string): Map<string, string> {
  const targets = new Map<string, string>()
  for (const match of xml.matchAll(/<Relationship\b([^>]*?)\/?\s*>/g)) {
    const attributes = match[1]
    const id = /\bId="([^"]+)"/.exec(attributes)?.[1]
    const target = /\bTarget="([^"]+)"/.exec(attributes)?.[1]
    const type = /\bType="([^"]+)"/.exec(attributes)?.[1]
    if (id && target && type?.endsWith('/image')) targets.set(id, decodeXml(target))
  }
  return targets
}

function mediaPath(target: string): string {
  const normalized = target.replace(/\\/g, '/').replace(/^\.\.\//, '')
  return normalized.startsWith('word/') ? normalized : `word/${normalized}`
}

export async function extractDocxAnchoredImages(
  bytes: Uint8Array
): Promise<ExtractedDocumentImage[]> {
  const zip = await JSZip.loadAsync(bytes)
  const documentXml = await zip.file('word/document.xml')?.async('string')
  const relationshipsXml = await zip.file('word/_rels/document.xml.rels')?.async('string')
  if (!documentXml || !relationshipsXml) return []

  const targets = relationshipTargets(relationshipsXml)
  const paragraphs: Array<{ text: string; imageIds: string[]; sourceCharOffset: number }> = []
  const sourceParts: string[] = []
  let sourceLength = 0

  for (const paragraphMatch of documentXml.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g)) {
    const paragraph = paragraphMatch[1]
    const text = [...paragraph.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)]
      .map((match) => decodeXml(match[1]))
      .join('')
      .trim()
    const sourceCharOffset = text && sourceParts.length > 0 ? sourceLength + 1 : sourceLength
    const imageIds = [...paragraph.matchAll(/<a:blip\b[^>]*\br:embed="([^"]+)"[^>]*\/?\s*>/g)].map(
      (match) => match[1]
    )
    paragraphs.push({ text, imageIds, sourceCharOffset })
    if (text) {
      if (sourceParts.length > 0) sourceLength += 1
      sourceParts.push(text)
      sourceLength += text.length
    }
  }

  const sourceText = sourceParts.join('\n')
  const images: ExtractedDocumentImage[] = []
  let anchorText = ''
  let totalBytes = 0

  for (const { text, imageIds, sourceCharOffset } of paragraphs) {
    if (text) anchorText = text
    if (!anchorText) continue

    for (const imageId of imageIds) {
      const target = targets.get(imageId)
      if (!target) continue
      const path = mediaPath(target)
      const fileName = path.split('/').pop() ?? ''
      const extension = fileName.split('.').pop()?.toLowerCase() ?? ''
      const mimeType = MIME_BY_EXTENSION[extension]
      const file = zip.file(path)
      if (!mimeType || !file) continue
      const imageBytes = await file.async('uint8array')
      if (
        imageBytes.byteLength > MAX_IMAGE_BYTES ||
        totalBytes + imageBytes.byteLength > MAX_DOCUMENT_IMAGE_BYTES
      ) {
        continue
      }
      totalBytes += imageBytes.byteLength
      images.push({
        anchorText,
        sourceCharOffset,
        sourceText,
        fileName,
        mimeType,
        bytes: imageBytes,
        order: images.length,
      })
    }
  }

  return images
}
