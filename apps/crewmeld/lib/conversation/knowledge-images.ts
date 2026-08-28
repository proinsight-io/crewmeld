export function appendMissingKnowledgeImages(
  content: string,
  references: Array<{ content: string; similarity?: number }>
): string {
  const imageReferences = references
    .map((reference, index) => ({
      reference,
      index,
      urls: [
        ...reference.content.matchAll(
          /!\[[^\]]*\]\((\/api\/(?:employee|public\/employees\/[^/)]+)\/ragflow\/(?:document-)?images\/[^)\s]+)\)/g
        ),
      ].map((match) => match[1]),
    }))
    .filter((item) => item.urls.length > 0)
    .sort(
      (a, b) =>
        (b.reference.similarity ?? Number.NEGATIVE_INFINITY) -
          (a.reference.similarity ?? Number.NEGATIVE_INFINITY) ||
        a.index - b.index
    )
  const urls = new Set(imageReferences[0]?.urls ?? [])
  const missing = [...urls].filter((url) => !content.includes(`](${url})`))
  return missing.length > 0
    ? `${content}${content ? '\n\n' : ''}${missing.map((url) => `![](${url})`).join('\n')}`
    : content
}
