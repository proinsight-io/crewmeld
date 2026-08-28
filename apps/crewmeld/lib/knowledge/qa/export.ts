import type { QaQuestionRecord } from './types'

function escapeCsv(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value
}

export const QA_CSV_HEADER = 'question,answer,enabled,sort_order,tags\r\n'

export function createQaCsvLine(row: QaQuestionRecord): string {
  return `${[row.question, row.answer, String(row.enabled), String(row.sortOrder), row.tags.join(',')].map(escapeCsv).join(',')}\r\n`
}

export function createQaCsv(rows: QaQuestionRecord[]): Uint8Array {
  return new TextEncoder().encode(`\uFEFF${QA_CSV_HEADER}${rows.map(createQaCsvLine).join('')}`)
}
