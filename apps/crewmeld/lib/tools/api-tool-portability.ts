import type { ApiToolSpec } from './api-tool-types'

/**
 * Matches `ctx.callApi("someId"` — captures the string-literal connection id.
 * Note: dynamic/variable ids (e.g. `ctx.callApi(myVar, ...)`) are not collected;
 * this is an accepted limitation of the static-analysis approach.
 */
const CALL_API_RE = /ctx\.callApi\s*\(\s*['"]([^'"]+)['"]/g

/**
 * Collect every connection id referenced by the spec.
 * Sources: `request.connectionId` + string-literal `ctx.callApi("...")` calls in pre/post.
 *
 * @param spec - The {@link ApiToolSpec} to inspect.
 * @returns Deduplicated array of connection id strings.
 */
export function collectConnectionRefs(spec: ApiToolSpec): string[] {
  const ids = new Set<string>()
  if (spec.request.connectionId) ids.add(spec.request.connectionId)
  for (const code of [spec.pre, spec.post]) {
    let m: RegExpExecArray | null
    CALL_API_RE.lastIndex = 0
    while ((m = CALL_API_RE.exec(code)) !== null) ids.add(m[1])
  }
  return Array.from(ids)
}

/**
 * Rewrite connection ids in a spec according to a `{oldId: newId}` mapping.
 * Ids not present in the mapping are left unchanged.
 *
 * @param spec - The {@link ApiToolSpec} to transform.
 * @param mapping - Map of old connection id to new connection id.
 * @returns A new {@link ApiToolSpec} with all mapped ids replaced.
 */
export function applyConnectionMapping(
  spec: ApiToolSpec,
  mapping: Record<string, string>
): ApiToolSpec {
  const remapCode = (code: string): string =>
    code.replace(CALL_API_RE, (full, id: string) =>
      mapping[id] !== undefined ? full.replace(id, mapping[id]) : full
    )

  return {
    pre: remapCode(spec.pre),
    post: remapCode(spec.post),
    request: {
      connectionId: mapping[spec.request.connectionId] ?? spec.request.connectionId,
    },
  }
}
