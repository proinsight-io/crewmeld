import { createHash } from 'node:crypto'

export interface QaCsvRenderRow {
  id: string
  question: string
  answer: string
  enabled: boolean
  sortOrder: number
  tags: string[]
}

function field(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value
}

export function renderQaBatchCsv(rows: QaCsvRenderRow[]): { bytes: Uint8Array; checksum: string } {
  const active = rows
    .filter((row) => row.enabled)
    .sort(
      (left, right) =>
        left.sortOrder - right.sortOrder || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
    )
  // RAGFlow QA parser expects question/answer rows without a header row.
  const lines: string[] = []
  for (const row of active) {
    lines.push(
      [row.question, row.answer, 'true', String(row.sortOrder), row.tags.join(',')]
        .map(field)
        .join(',')
    )
  }
  const bytes = new TextEncoder().encode(`${lines.join('\r\n')}\r\n`)
  return { bytes, checksum: createHash('sha256').update(bytes).digest('hex') }
}
