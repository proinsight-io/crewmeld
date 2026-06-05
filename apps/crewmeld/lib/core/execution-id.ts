/**
 * Shared execution ID generator.
 *
 * Format: `<prefix>_<YYYYMMDD>_<shortUuid>`
 * Example: `sop_20260526_a1b2c3d4e5f6`
 *
 * The ID is FLAT (no slashes) — safe for DB primary keys, MinIO object keys,
 * Redis keys, and URL path segments. The embedded date is parsed by
 * {@link parseExecutionDate} when the filesystem IO layer needs to build
 * date-organized directories (e.g. `io/2026/05/26/<id>/`).
 *
 * @param prefix     Context identifier: 'test' (dev-studio), 'sop' (SOP), etc.
 * @param dateAnchor Override the YYYYMMDD field with a specific instant
 *                   (defaults to "now"). Used by dev-studio test runs to
 *                   tie the execId — and therefore the per-run sop-files
 *                   subdir — to the **session creation date** rather than
 *                   the run-fire date, so all run-tests of a long-lived
 *                   session share one date dir. Production SOPs leave this
 *                   undefined, so the embedded date is the SOP trigger date
 *                   (which equals the SOP start date).
 */

import { randomUUID } from 'node:crypto'

export function generateExecutionId(prefix = 'exec', dateAnchor?: Date | string): string {
  const anchor = dateAnchor === undefined
    ? new Date()
    : dateAnchor instanceof Date
      ? dateAnchor
      : new Date(dateAnchor)
  if (Number.isNaN(anchor.getTime())) {
    throw new Error(`generateExecutionId: invalid dateAnchor: ${String(dateAnchor)}`)
  }
  const y = anchor.getUTCFullYear()
  const m = String(anchor.getUTCMonth() + 1).padStart(2, '0')
  const d = String(anchor.getUTCDate()).padStart(2, '0')
  const uid = randomUUID().slice(0, 12)
  return `${prefix}_${y}${m}${d}_${uid}`
}

/**
 * Extract the YYYY/MM/DD path prefix from a date-embedded execution ID.
 * Returns `null` for legacy IDs that don't embed a date.
 */
export function parseExecutionDate(executionId: string): string | null {
  const m = executionId.match(/_(\d{4})(\d{2})(\d{2})_/)
  if (!m) return null
  return `${m[1]}/${m[2]}/${m[3]}`
}
