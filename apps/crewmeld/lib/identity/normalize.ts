/**
 * [IDENTITY-FIELD-MAP · MERGE→dev0.0.1] Pure raw-record → ChannelUserDetail mapper.
 *
 * Applies a {@link ChannelFieldMapping} to a channel's raw directory record,
 * producing the normalized {@link ChannelUserDetail}. No I/O, no ontology — the
 * single place the field correspondence lives, replacing the per-fetcher hardcode.
 */

import type { ChannelUserDetail } from '@/lib/channels/directory-types'
import type { ChannelFieldMapping, FieldPathSpec, FieldValueType } from './field-map-types'

/**
 * Read a dotted/indexed path (e.g. `direct_leader.0`) from a record.
 * Returns undefined when any hop is absent.
 */
function readPath(raw: Record<string, unknown>, path: string): unknown {
  let cur: unknown = raw
  for (const seg of path.split('.')) {
    if (cur === null || cur === undefined) return undefined
    if (typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[seg]
  }
  return cur
}

/**
 * Coerce any value into the field's declared type.
 * Returns undefined for absent string fields; empty array for absent array fields.
 */
function coerce(value: unknown, type: FieldValueType): string | string[] | undefined {
  if (type === 'string') {
    if (value === null || value === undefined) return undefined
    return String(value)
  }
  // string[]
  if (value === null || value === undefined) return []
  if (Array.isArray(value)) return value.map((v) => String(v))
  return value ? [String(value)] : []
}

/**
 * Resolve one cell spec against the raw record.
 * Returns constant value for 'const' cells; reads path for 'path' cells.
 */
function resolveSpec(raw: Record<string, unknown>, spec: FieldPathSpec): unknown {
  return spec.kind === 'const' ? spec.value : readPath(raw, spec.path)
}

/**
 * Map a channel raw record to {@link ChannelUserDetail} per the field mapping.
 *
 * @param raw     - Channel-native record (incl. fetcher-resolved extras like deptNames + a non-empty `attributes`).
 * @param mapping - Active field map (DB override or default seed).
 * @param channel - Channel type key used to pick each field's cell.
 * @returns Normalized {@link ChannelUserDetail} with fields and attributes populated per the mapping.
 */
export function normalizeIdentityFromRaw(
  raw: Record<string, unknown>,
  mapping: ChannelFieldMapping,
  channel: string
): ChannelUserDetail {
  const out: Record<string, unknown> = {}

  for (const field of mapping.fields) {
    const spec = mapping.paths[field.key]?.[channel]
    if (!spec) continue // no spec for this channel ⇒ omit the field entirely
    const coerced = coerce(resolveSpec(raw, spec), field.valueType)
    if (field.valueType === 'string' && coerced === undefined) continue // omit absent string fields
    if (field.target === 'attributes') {
      const attrs = (out.attributes as Record<string, unknown> | undefined) ?? {}
      attrs[field.key] = coerced
      out.attributes = attrs
    } else {
      out[field.key] = coerced
    }
  }

  // Pass the fetcher-populated custom attributes through verbatim, when non-empty.
  const rawAttrs = raw.attributes
  if (rawAttrs && typeof rawAttrs === 'object' && Object.keys(rawAttrs as object).length > 0) {
    out.attributes = { ...(out.attributes as Record<string, unknown> | undefined), ...(rawAttrs as Record<string, unknown>) }
  }

  return out as ChannelUserDetail
}
