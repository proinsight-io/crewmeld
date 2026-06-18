/**
 * [IDENTITY-FIELD-MAP · MERGE→dev0.0.1] Loads the active channel field map.
 *
 * Base = DEFAULT_CHANNEL_FIELD_MAP; DB rows override per-field and append custom
 * rows. Empty table ⇒ pure default (unchanged behavior). 60s in-process cache.
 */

import { db } from '@crewmeld/db'
import { channelFieldMappings } from '@crewmeld/db/schema'
import { DEFAULT_CHANNEL_FIELD_MAP } from './field-map-defaults'
import type {
  ChannelFieldMapping,
  FieldPathSpec,
  FieldTarget,
  FieldValueType,
  NormalizedFieldDef,
} from './field-map-types'

const CACHE_TTL_MS = 60_000
let cached: { value: ChannelFieldMapping; at: number } | null = null

/** @internal Test-only cache reset. */
export function __clearFieldMapCache(): void {
  cached = null
}

/** Drop the cache after a write so the next resolve sees fresh config. */
export function clearFieldMapCache(): void {
  cached = null
}

/** Shape of a persisted channel field mapping row. */
interface MappingRow {
  fieldKey: string
  label: string
  isCustom: boolean
  target: string
  valueType: string
  paths: unknown
}

/** Merge DB rows over the default seed: present fields replace, customs append. */
function rowsToMapping(rows: MappingRow[]): ChannelFieldMapping {
  const fields: NormalizedFieldDef[] = DEFAULT_CHANNEL_FIELD_MAP.fields.map((f) => ({ ...f }))
  const paths: Record<string, Record<string, FieldPathSpec>> = {}
  for (const [k, v] of Object.entries(DEFAULT_CHANNEL_FIELD_MAP.paths)) paths[k] = { ...v }

  for (const r of rows) {
    const def: NormalizedFieldDef = {
      key: r.fieldKey,
      label: r.label,
      isCustom: r.isCustom,
      target: r.target as FieldTarget,
      valueType: r.valueType as FieldValueType,
    }
    const idx = fields.findIndex((f) => f.key === r.fieldKey)
    if (idx >= 0) fields[idx] = def
    else fields.push(def)
    paths[r.fieldKey] = (r.paths as Record<string, FieldPathSpec>) ?? {}
  }
  return { fields, paths }
}

/** Resolve the active map (DB override merged over the default seed). */
export async function loadActiveFieldMap(now: () => number = Date.now): Promise<ChannelFieldMapping> {
  if (cached && now() - cached.at < CACHE_TTL_MS) return cached.value
  const rows = (await db.select().from(channelFieldMappings)) as MappingRow[]
  const value = rows.length === 0 ? DEFAULT_CHANNEL_FIELD_MAP : rowsToMapping(rows)
  cached = { value, at: now() }
  return value
}

/** Read the persisted map merged over the seed (cache-bypassing). */
export async function getStoredFieldMap(): Promise<ChannelFieldMapping> {
  const rows = (await db.select().from(channelFieldMappings)) as MappingRow[]
  return rows.length === 0 ? DEFAULT_CHANNEL_FIELD_MAP : rowsToMapping(rows)
}

/** Replace the entire stored map with `mapping` (full-set upsert), then bust the cache. */
export async function putFieldMap(mapping: ChannelFieldMapping): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(channelFieldMappings)
    if (mapping.fields.length > 0) {
      await tx.insert(channelFieldMappings).values(
        mapping.fields.map((f) => ({
          fieldKey: f.key,
          label: f.label,
          isCustom: f.isCustom,
          target: f.target,
          valueType: f.valueType,
          paths: mapping.paths[f.key] ?? {},
        })),
      )
    }
  })
  clearFieldMapCache()
}
