/**
 * [IDENTITY-FIELD-MAP · MERGE→dev0.0.1] Declarative channel→normalized field map types.
 *
 * Pure types + no ontology dependency, so this whole field-map subsystem merges
 * to dev0.0.1. The matrix maps each normalized identity field (row) to a raw
 * field path (or constant) per channel type (column).
 */

/** Coercion target type for a normalized field. */
export type FieldValueType = 'string' | 'string[]'

/** Where a normalized field lands on the resolved identity. */
export type FieldTarget = 'scope' | 'attributes'

/** A single cell: read a raw path, or use a literal constant. */
export type FieldPathSpec = { kind: 'path'; path: string } | { kind: 'const'; value: string }

/** One normalized field (matrix row). */
export interface NormalizedFieldDef {
  /** Stable key, e.g. 'employeeNo'. Core keys match ChannelUserDetail keys. */
  key: string
  /** zh-CN display label, e.g. '工号'. */
  label: string
  /** Core keys are fixed (not deletable in UI); custom rows land in attributes. */
  isCustom: boolean
  /** 'scope' → ChannelUserDetail strong field; 'attributes' → raw.attributes. */
  target: FieldTarget
  /** Coercion applied when reading the raw value. */
  valueType: FieldValueType
}

/** The full global mapping: field definitions + per-field per-channel cell specs. */
export interface ChannelFieldMapping {
  /** Ordered field definitions (rows). */
  fields: NormalizedFieldDef[]
  /** fieldKey → channelType → cell spec. Absent channel ⇒ field omitted for that channel. */
  paths: Record<string, Record<string, FieldPathSpec>>
}
