import { QA_SORT_ORDER_MAX, QA_SORT_ORDER_MIN, type QaCsvRow } from './csv-validation'
import type { QaQuestionInput, QaQuestionRepository } from './types'

export type QaServiceErrorCode =
  | 'QA_KNOWLEDGE_BASE_REQUIRED'
  | 'QA_VALIDATION_FAILED'
  | 'QA_VERSION_CONFLICT'
  | 'QA_DUPLICATE_QUESTION'

export class QaServiceError extends Error {
  constructor(
    public readonly code: QaServiceErrorCode,
    public readonly status: number,
    public readonly details?: unknown
  ) {
    super(code)
  }
}

export function normalizeQuestion(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase()
}

export function parseQuestionInput(value: unknown, partial = false): Partial<QaQuestionInput> {
  if (!value || typeof value !== 'object') throw new QaServiceError('QA_VALIDATION_FAILED', 400)
  const body = value as Record<string, unknown>
  const output: Partial<QaQuestionInput> = {}
  for (const field of ['question', 'answer'] as const) {
    if (body[field] === undefined && partial) continue
    if (typeof body[field] !== 'string' || body[field].trim().length === 0)
      throw new QaServiceError('QA_VALIDATION_FAILED', 400, { field })
    output[field] = body[field].trim()
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean')
      throw new QaServiceError('QA_VALIDATION_FAILED', 400, { field: 'enabled' })
    output.enabled = body.enabled
  } else if (!partial) output.enabled = true
  if (body.sortOrder !== undefined) {
    if (
      !Number.isSafeInteger(body.sortOrder) ||
      (body.sortOrder as number) < QA_SORT_ORDER_MIN ||
      (body.sortOrder as number) > QA_SORT_ORDER_MAX
    )
      throw new QaServiceError('QA_VALIDATION_FAILED', 400, { field: 'sortOrder' })
    output.sortOrder = body.sortOrder as number
  } else if (!partial) output.sortOrder = 0
  if (body.tags !== undefined) {
    if (
      !Array.isArray(body.tags) ||
      body.tags.some((tag) => typeof tag !== 'string' || !tag.trim())
    )
      throw new QaServiceError('QA_VALIDATION_FAILED', 400, { field: 'tags' })
    output.tags = [...new Set(body.tags.map((tag) => (tag as string).trim()))]
  } else if (!partial) output.tags = []
  return output
}

function csvBoolean(value: string | undefined): boolean {
  if (value === undefined || value === '') return true
  if (['true', '1'].includes(value.toLowerCase())) return true
  if (['false', '0'].includes(value.toLowerCase())) return false
  throw new QaServiceError('QA_VALIDATION_FAILED', 400, { field: 'enabled' })
}

export function csvRowsToInputs(rows: QaCsvRow[]): QaQuestionInput[] {
  return rows
    .map((row) => ({
      question: row.question.trim(),
      answer: row.answer.trim(),
      enabled: csvBoolean(row.enabled),
      sortOrder: row.sort_order ? Number(row.sort_order) : 0,
      tags: row.tags
        ? [
            ...new Set(
              row.tags
                .split(',')
                .map((tag) => tag.trim())
                .filter(Boolean)
            ),
          ]
        : [],
    }))
    .map((input) => {
      if (
        !input.question ||
        !input.answer ||
        !Number.isSafeInteger(input.sortOrder) ||
        input.sortOrder < QA_SORT_ORDER_MIN ||
        input.sortOrder > QA_SORT_ORDER_MAX
      )
        throw new QaServiceError('QA_VALIDATION_FAILED', 400)
      return input
    })
}

export async function assertQaKnowledgeBase(
  repository: QaQuestionRepository,
  id: string
): Promise<void> {
  if (!(await repository.isQaKnowledgeBase(id)))
    throw new QaServiceError('QA_KNOWLEDGE_BASE_REQUIRED', 409)
}

export async function rejectExistingDuplicates(
  repository: QaQuestionRepository,
  knowledgeBaseId: string,
  inputs: QaQuestionInput[],
  excludeId?: string
): Promise<void> {
  const normalized = inputs
    .filter((row) => row.enabled)
    .map((row) => normalizeQuestion(row.question))
  const conflicts = await repository.findEnabledNormalized(knowledgeBaseId, normalized, excludeId)
  if (conflicts.length) throw new QaServiceError('QA_DUPLICATE_QUESTION', 409, { conflicts })
}
