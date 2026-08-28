import { QA_CSV_MAX_BYTES } from '@/lib/knowledge/qa/csv-validation'

export type QaClientFileError = 'FILE_COUNT' | 'INVALID_TYPE' | 'FILE_TOO_LARGE'

const QA_CSV_MIME_TYPES = new Set([
  'text/csv',
  'application/csv',
  'text/comma-separated-values',
  'application/vnd.ms-excel',
])

/** Performs fast UX checks only; the preview API remains authoritative. */
export function getQaClientFileError(files: File[]): QaClientFileError | null {
  if (files.length !== 1) return 'FILE_COUNT'
  const [file] = files
  if (!file) return 'FILE_COUNT'
  const mime = file.type.toLowerCase().split(';', 1)[0]?.trim() ?? ''
  if (!file.name.toLowerCase().endsWith('.csv') || !QA_CSV_MIME_TYPES.has(mime)) {
    return 'INVALID_TYPE'
  }
  if (file.size > QA_CSV_MAX_BYTES) return 'FILE_TOO_LARGE'
  return null
}

export function getQaPreviewUrl(datasetId: string): string {
  return `/api/employee/ragflow/datasets/${encodeURIComponent(datasetId)}/qa/preview`
}
