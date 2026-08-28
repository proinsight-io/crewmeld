export const QA_CSV_MAX_BYTES = 10 * 1024 * 1024
export const QA_CSV_MAX_ROWS = 10_000
export const QA_SORT_ORDER_MIN = -2_147_483_648
export const QA_SORT_ORDER_MAX = 2_147_483_647

export type QaCsvValidationErrorCode =
  | 'INVALID_EXTENSION'
  | 'INVALID_MIME'
  | 'FILE_TOO_LARGE'
  | 'INVALID_UTF8'
  | 'BINARY_CONTENT'
  | 'INVALID_QUOTING'
  | 'MISSING_HEADER'
  | 'UNSUPPORTED_HEADER'
  | 'DUPLICATE_HEADER'
  | 'COLUMN_COUNT_MISMATCH'
  | 'EMPTY_QUESTION'
  | 'EMPTY_ANSWER'
  | 'INVALID_ENABLED'
  | 'INVALID_SORT_ORDER'
  | 'DUPLICATE_QUESTION'
  | 'TOO_MANY_ROWS'

export interface QaCsvValidationError {
  code: QaCsvValidationErrorCode
  row?: number
  field?: string
}

export interface QaCsvRow {
  row: number
  question: string
  answer: string
  enabled?: string
  sort_order?: string
  tags?: string
}

export interface QaCsvValidationResult {
  valid: boolean
  headers: string[]
  rows: QaCsvRow[]
  errors: QaCsvValidationError[]
}

const CSV_MIME_TYPES = new Set([
  'text/csv',
  'application/csv',
  'text/comma-separated-values',
  'application/vnd.ms-excel',
])
const ALLOWED_HEADERS = new Set(['question', 'answer', 'enabled', 'sort_order', 'tags'])

interface ParsedRecord {
  row: number
  fields: string[]
}

interface CsvParseResult {
  records: ParsedRecord[]
  error?: QaCsvValidationError
}

/** Validates a QA import file and returns preview-ready rows and row-numbered errors. */
export async function validateQaCsvFile(file: File): Promise<QaCsvValidationResult> {
  const errors: QaCsvValidationError[] = []
  if (!file.name.toLowerCase().endsWith('.csv')) errors.push({ code: 'INVALID_EXTENSION' })
  const mime = file.type.toLowerCase().split(';', 1)[0]?.trim() ?? ''
  if (!CSV_MIME_TYPES.has(mime)) errors.push({ code: 'INVALID_MIME' })
  if (file.size > QA_CSV_MAX_BYTES) errors.push({ code: 'FILE_TOO_LARGE' })
  if (errors.length > 0) return { valid: false, headers: [], rows: [], errors }

  const bytes = new Uint8Array(await file.arrayBuffer())
  if (bytes.includes(0) || hasArchiveMagic(bytes)) {
    return { valid: false, headers: [], rows: [], errors: [{ code: 'BINARY_CONTENT' }] }
  }

  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return { valid: false, headers: [], rows: [], errors: [{ code: 'INVALID_UTF8' }] }
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)

  const parsed = parseCsv(text, QA_CSV_MAX_ROWS)
  if (parsed.error) return { valid: false, headers: [], rows: [], errors: [parsed.error] }
  const [headerRecord, ...dataRecords] = parsed.records
  if (!headerRecord) {
    return { valid: false, headers: [], rows: [], errors: [{ code: 'MISSING_HEADER', row: 1 }] }
  }

  const headers = headerRecord.fields.map((header) => header.trim())
  const seenHeaders = new Set<string>()
  for (const header of headers) {
    if (seenHeaders.has(header)) errors.push({ code: 'DUPLICATE_HEADER', row: 1, field: header })
    seenHeaders.add(header)
    if (!ALLOWED_HEADERS.has(header))
      errors.push({ code: 'UNSUPPORTED_HEADER', row: 1, field: header })
  }
  for (const required of ['question', 'answer']) {
    if (!seenHeaders.has(required)) errors.push({ code: 'MISSING_HEADER', row: 1, field: required })
  }
  if (errors.length > 0) return { valid: false, headers, rows: [], errors }

  const rows: QaCsvRow[] = []
  const questions = new Set<string>()
  for (const record of dataRecords) {
    if (record.fields.every((field) => field.trim() === '')) continue
    if (rows.length >= QA_CSV_MAX_ROWS) {
      errors.push({ code: 'TOO_MANY_ROWS', row: record.row })
      break
    }
    if (record.fields.length !== headers.length) {
      errors.push({ code: 'COLUMN_COUNT_MISMATCH', row: record.row })
      continue
    }
    const values = Object.fromEntries(
      headers.map((header, index) => [header, record.fields[index]?.trim() ?? ''])
    )
    const question = values.question ?? ''
    const answer = values.answer ?? ''
    if (!question) errors.push({ code: 'EMPTY_QUESTION', row: record.row, field: 'question' })
    if (!answer) errors.push({ code: 'EMPTY_ANSWER', row: record.row, field: 'answer' })
    const enabled = values.enabled
    if (
      enabled !== undefined &&
      enabled !== '' &&
      !['true', 'false', '1', '0'].includes(enabled.toLowerCase())
    ) {
      errors.push({ code: 'INVALID_ENABLED', row: record.row, field: 'enabled' })
    }
    const sortOrder = values.sort_order
    if (sortOrder !== undefined && sortOrder !== '') {
      const parsedSortOrder = Number(sortOrder)
      if (
        !/^-?\d+$/.test(sortOrder) ||
        !Number.isSafeInteger(parsedSortOrder) ||
        parsedSortOrder < QA_SORT_ORDER_MIN ||
        parsedSortOrder > QA_SORT_ORDER_MAX
      ) {
        errors.push({ code: 'INVALID_SORT_ORDER', row: record.row, field: 'sort_order' })
      }
    }
    if (question && questions.has(question)) {
      errors.push({ code: 'DUPLICATE_QUESTION', row: record.row, field: 'question' })
    }
    if (question) questions.add(question)
    rows.push({
      row: record.row,
      question,
      answer,
      ...(values.enabled !== undefined ? { enabled: values.enabled } : {}),
      ...(values.sort_order !== undefined ? { sort_order: values.sort_order } : {}),
      ...(values.tags !== undefined ? { tags: values.tags } : {}),
    })
  }
  return { valid: errors.length === 0, headers, rows, errors }
}

function hasArchiveMagic(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04
  )
}

function parseCsv(text: string, maxDataRows: number): CsvParseResult {
  const records: ParsedRecord[] = []
  let fields: string[] = []
  let field = ''
  let recordRow = 1
  let physicalRow = 1
  let dataRows = 0
  let state: 'start' | 'unquoted' | 'quoted' | 'afterQuote' = 'start'

  const finishField = () => {
    fields.push(field)
    field = ''
    state = 'start'
  }
  const finishRecord = (): QaCsvValidationError | undefined => {
    finishField()
    const isHeader = records.length === 0
    const isBlank = fields.every((value) => value.trim() === '')
    if (!isHeader && !isBlank) {
      dataRows += 1
      if (dataRows > maxDataRows) return { code: 'TOO_MANY_ROWS', row: recordRow }
    }
    if (isHeader || !isBlank) records.push({ row: recordRow, fields })
    fields = []
    recordRow = physicalRow + 1
  }

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? ''
    if (state === 'quoted') {
      if (char === '"') state = 'afterQuote'
      else {
        field += char
        if (char === '\n') physicalRow += 1
      }
      continue
    }
    if (state === 'afterQuote') {
      if (char === '"') {
        field += '"'
        state = 'quoted'
      } else if (char === ',') finishField()
      else if (char === '\n') {
        const error = finishRecord()
        if (error) return { records, error }
        physicalRow += 1
        recordRow = physicalRow
      } else if (char === '\r' && text[index + 1] === '\n') {
        const error = finishRecord()
        if (error) return { records, error }
        index += 1
        physicalRow += 1
        recordRow = physicalRow
      } else return { records, error: { code: 'INVALID_QUOTING', row: physicalRow } }
      continue
    }
    if (state === 'start' && char === '"') state = 'quoted'
    else if (state === 'unquoted' && char === '"') {
      return { records, error: { code: 'INVALID_QUOTING', row: physicalRow } }
    } else if (char === ',') finishField()
    else if (char === '\n') {
      const error = finishRecord()
      if (error) return { records, error }
      physicalRow += 1
      recordRow = physicalRow
    } else if (char === '\r' && text[index + 1] === '\n') {
      const error = finishRecord()
      if (error) return { records, error }
      index += 1
      physicalRow += 1
      recordRow = physicalRow
    } else {
      field += char
      state = 'unquoted'
    }
  }
  if (state === 'quoted') return { records, error: { code: 'INVALID_QUOTING', row: physicalRow } }
  if (field || fields.length > 0 || state === 'afterQuote') {
    const error = finishRecord()
    if (error) return { records, error }
  }
  return { records }
}
