import { QaServiceError } from './service'

export interface TransactionAdapter<TTransaction> {
  transaction<T>(callback: (transaction: TTransaction) => Promise<T>): Promise<T>
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '23505'
  )
}

/** Runs production repository work transactionally and normalizes uniqueness races. */
export async function runQaTransaction<TTransaction, TResult>(
  adapter: TransactionAdapter<TTransaction>,
  operation: (transaction: TTransaction) => Promise<TResult>
): Promise<TResult> {
  try {
    return await adapter.transaction(operation)
  } catch (error) {
    if (isUniqueViolation(error)) throw new QaServiceError('QA_DUPLICATE_QUESTION', 409)
    throw error
  }
}

/** Reads frozen IDs in bounded chunks, preserving snapshot order and skipping deletes. */
export async function* readQaSnapshotPages<TRow extends { id: string }>(
  ids: string[],
  pageSize: number,
  fetchRows: (ids: string[]) => Promise<TRow[]>
): AsyncIterable<TRow[]> {
  for (let offset = 0; offset < ids.length; offset += pageSize) {
    const chunk = ids.slice(offset, offset + pageSize)
    const rows = await fetchRows(chunk)
    const byId = new Map(rows.map((row) => [row.id, row]))
    yield chunk.flatMap((id) => {
      const row = byId.get(id)
      return row ? [row] : []
    })
  }
}
