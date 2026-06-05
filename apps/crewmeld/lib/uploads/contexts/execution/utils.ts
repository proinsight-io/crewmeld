import type { UserFile } from '@/lib/types/execution'
import { isUuid, sanitizeFileName } from '@/lib/types/execution-constants'

// ─── types ───────────────────────────────────────────────────────────────────

/** Identifiers that scope a file to a specific workflow execution. */
export interface ExecutionContext {
  workspaceId: string
  workflowId: string
  executionId: string
}

// ─── key helpers ─────────────────────────────────────────────────────────────

/**
 * Build the storage key for an execution-scoped file.
 *
 * Format: `execution/{workspaceId}/{workflowId}/{executionId}/{safeFileName}`
 */
export function generateExecutionFileKey(context: ExecutionContext, fileName: string): string {
  const { workspaceId, workflowId, executionId } = context
  const safeFileName = sanitizeFileName(fileName)
  return `execution/${workspaceId}/${workflowId}/${executionId}/${safeFileName}`
}

/**
 * Generate a short unique identifier for an execution file record.
 * Uses a millisecond timestamp combined with a random alphanumeric suffix.
 */
export function generateFileId(): string {
  const suffix = Math.random().toString(36).substring(2, 9)
  return `file_${Date.now()}_${suffix}`
}

export { isUuid }

// ─── pattern matching ────────────────────────────────────────────────────────

/**
 * Return `true` when the key follows the execution file pattern and all three
 * UUID segments are structurally valid.
 *
 * Expected format: `execution/<workspaceId>/<workflowId>/<executionId>/<filename>`
 */
function isValidExecutionKey(key: string): boolean {
  if (!key || key.startsWith('/api/') || key.startsWith('http')) {
    return false
  }

  const segments = key.split('/')

  if (segments[0] !== 'execution' || segments.length < 5) {
    return false
  }

  const [, workspaceId, workflowId, executionId] = segments
  return isUuid(workspaceId) && isUuid(workflowId) && executionId.length > 0
}

/**
 * Return `true` when the `UserFile` originates from execution-scoped storage.
 * Files without a key are never classified as execution files.
 */
export function isExecutionFile(file: UserFile): boolean {
  return !!file.key && isValidExecutionKey(file.key)
}
