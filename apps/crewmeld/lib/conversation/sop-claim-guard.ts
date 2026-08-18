/**
 * Detect LLM replies that assert a SOP execution is active/started while
 * referencing an execution ID that was never actually created.
 *
 * This is the safety net for the case where the model skips the required
 * `sop_<id>` tool_call and instead free-writes a plausible-looking "task
 * started" acknowledgement, copying the wording/ID format it has seen in its
 * own earlier (real) replies. The engine checks the claimed IDs against
 * `sop_executions` before a plain-text reply is persisted/sent; anything
 * flagged here never reaches the user.
 */

const SOP_EXECUTION_ID_PATTERN = /\bsop_\d{8}_[0-9a-f-]{6,24}\b/gi

/**
 * Markers indicating the sentence is an honest "not found" report, not an
 * active-task claim.
 *
 * These are literal phrase fragments matched against the LLM's own reply
 * text, not identifiers or UI copy — the Chinese entries are required
 * because the bound model frequently answers in Chinese (per this
 * platform's target market) and the match must work against that output
 * verbatim. This is intentionally exempt from the "no Chinese in code"
 * convention, which targets identifiers/comments/log text, not
 * language-matching data.
 */
const NOT_FOUND_MARKERS = [
  '未找到',
  '没有找到',
  '未能查询到',
  '查询不到',
  '无法找到',
  '不存在',
  'not found',
  'no record',
  'no such',
  "doesn't exist",
  'does not exist',
  "couldn't find",
  'cannot find',
]

/** Extract all `sop_<date>_<id>`-shaped tokens referenced in a reply, deduped. */
export function extractSopExecutionIds(text: string): string[] {
  const matches = text.match(SOP_EXECUTION_ID_PATTERN) ?? []
  return [...new Set(matches)]
}

/**
 * Given a reply's full text and the set of execution IDs confirmed to exist
 * in `sop_executions`, return the IDs the reply asserts as active/started
 * (i.e. not hedged by a "not found" disclaimer on the same line) that don't
 * actually exist. An empty result means every SOP claim in the reply is
 * either verified or honestly reported as not-found — safe to send as-is.
 */
export function findUnverifiedActiveSopClaims(text: string, existingIds: Set<string>): string[] {
  const bogus = new Set<string>()
  for (const line of text.split(/\n+/)) {
    const ids = line.match(SOP_EXECUTION_ID_PATTERN) ?? []
    if (ids.length === 0) continue
    const lowerLine = line.toLowerCase()
    const isNotFoundReport = NOT_FOUND_MARKERS.some((marker) =>
      lowerLine.includes(marker.toLowerCase())
    )
    if (isNotFoundReport) continue
    for (const id of ids) {
      if (!existingIds.has(id)) bogus.add(id)
    }
  }
  return [...bogus]
}
