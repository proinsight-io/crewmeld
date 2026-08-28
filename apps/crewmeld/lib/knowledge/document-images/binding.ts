export interface SourceImageForBinding {
  id: string
  sourceCharOffset: number | null
  sourceText: string | null
  anchorText: string
  sortOrder: number
}

export interface RealChunkForBinding {
  id: string
  content: string
  positions?: unknown[]
}

export type ImageBindingDecision =
  | { imageId: string; chunkId: string; status: 'bound'; error: null }
  | { imageId: string; chunkId: null; status: 'failed'; error: string }

interface NormalizedText {
  value: string
  sourceOffsets: number[]
}

interface SourceRange {
  start: number
  end: number
}

function normalizeWithOffsets(value: string): NormalizedText {
  let normalized = ''
  const sourceOffsets: number[] = []

  for (let offset = 0; offset < value.length; ) {
    const codePoint = value.codePointAt(offset)
    if (codePoint === undefined) break
    const sourceCharacter = String.fromCodePoint(codePoint)
    const comparable = sourceCharacter.normalize('NFKC').toLocaleLowerCase()
    for (const character of comparable) {
      if (!/[\p{L}\p{N}]/u.test(character)) continue
      normalized += character
      sourceOffsets.push(offset)
    }
    offset += sourceCharacter.length
  }

  return { value: normalized, sourceOffsets }
}

function normalize(value: string): string {
  return normalizeWithOffsets(value).value
}

function findChunkSourceRanges(
  sourceText: string,
  chunks: RealChunkForBinding[]
): Array<SourceRange | null> {
  const source = normalizeWithOffsets(sourceText)
  const ranges: Array<SourceRange | null> = []
  let cursor = 0

  for (const chunk of chunks) {
    const chunkText = normalize(chunk.content)
    if (!chunkText) {
      ranges.push(null)
      continue
    }
    const start = source.value.indexOf(chunkText, cursor)
    if (start < 0) {
      ranges.push(null)
      continue
    }
    const lastNormalizedOffset = start + chunkText.length - 1
    const sourceStart = source.sourceOffsets[start]
    const sourceEnd = source.sourceOffsets[lastNormalizedOffset]
    if (sourceStart === undefined || sourceEnd === undefined) {
      ranges.push(null)
      continue
    }
    ranges.push({ start: sourceStart, end: sourceEnd + 1 })
    cursor = start + chunkText.length
  }

  return ranges
}

export function bindImagesToRealChunks(
  images: SourceImageForBinding[],
  chunks: RealChunkForBinding[]
): ImageBindingDecision[] {
  const orderedImages = [...images].sort((left, right) => left.sortOrder - right.sortOrder)
  if (chunks.length === 0) {
    return orderedImages.map((image) => ({
      imageId: image.id,
      chunkId: null,
      status: 'failed',
      error: 'no-chunks',
    }))
  }

  const rangesBySource = new Map<string, Array<SourceRange | null>>()

  return orderedImages.map((image) => {
    if (image.sourceCharOffset === null || !image.sourceText) {
      return {
        imageId: image.id,
        chunkId: null,
        status: 'failed' as const,
        error: 'missing-source-position',
      }
    }
    let ranges = rangesBySource.get(image.sourceText)
    if (!ranges) {
      ranges = findChunkSourceRanges(image.sourceText, chunks)
      rangesBySource.set(image.sourceText, ranges)
    }
    const candidates = ranges
      .map((range, index) => ({ range, index }))
      .filter(
        (candidate): candidate is { range: SourceRange; index: number } =>
          candidate.range !== null &&
          candidate.range.start <= image.sourceCharOffset! &&
          image.sourceCharOffset! <= candidate.range.end
      )
    if (candidates.length !== 1) {
      return {
        imageId: image.id,
        chunkId: null,
        status: 'failed' as const,
        error: candidates.length > 1 ? 'ambiguous-aligned-chunk' : 'no-aligned-chunk',
      }
    }
    return {
      imageId: image.id,
      chunkId: chunks[candidates[0].index].id,
      status: 'bound' as const,
      error: null,
    }
  })
}
