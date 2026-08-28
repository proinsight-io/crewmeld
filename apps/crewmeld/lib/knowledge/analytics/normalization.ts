/** Normalize only presentation noise so distinct meanings are never merged automatically. */
export function normalizeObservedQuestion(value: string): string {
  return value
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase()
    .replace(/[？?！!。.，,、；;：:]+$/g, '')
    .trim()
}
