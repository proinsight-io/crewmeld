import { applyConnectionMapping, collectConnectionRefs } from './api-tool-portability'
import type { ApiToolConnectionRequirement, ApiToolSpec } from './api-tool-types'

export const API_TOOL_PACKAGE_MARKER = '_crewmeld_api_tool' as const
export const API_TOOL_PACKAGE_VERSION = 1

/**
 * Plain-JSON, secret-free, portable representation of an API tool (.cmapi).
 * Contains everything needed to recreate a tool on another CrewMeld instance
 * after the operator maps the referenced connection ids to local ones.
 */
export interface ApiToolPackage {
  _crewmeld_api_tool: true
  version: number
  name: string
  description: string
  toolVersion: string
  parameters: unknown
  apiSpec: ApiToolSpec
  /** Connections the tool needs, by reference id + display name (NO secrets). */
  connectionRequirements: ApiToolConnectionRequirement[]
}

/** Input for {@link buildApiToolPackage}. */
export interface BuildApiToolPackageInput {
  name: string
  description: string
  toolVersion: string
  parameters: unknown
  apiSpec: ApiToolSpec
  /** connectionId -> display name, for human-friendly requirement labels. */
  connectionNames: Record<string, string>
}

/**
 * Build a secret-free .cmapi package from a tool's fields.
 *
 * Connection ids are collected via {@link collectConnectionRefs} and enriched
 * with display names from `connectionNames`. Ids absent from the map fall back
 * to the raw id string.
 *
 * @param input - Tool fields and a connection name lookup map.
 * @returns A fully-formed {@link ApiToolPackage} ready for JSON serialization.
 */
export function buildApiToolPackage(input: BuildApiToolPackageInput): ApiToolPackage {
  const refs = collectConnectionRefs(input.apiSpec)
  const connectionRequirements: ApiToolConnectionRequirement[] = refs.map((ref) => ({
    ref,
    name: input.connectionNames[ref] ?? ref,
    type: 'custom_api',
  }))
  return {
    _crewmeld_api_tool: true,
    version: API_TOOL_PACKAGE_VERSION,
    name: input.name,
    description: input.description,
    toolVersion: input.toolVersion,
    parameters: input.parameters,
    apiSpec: input.apiSpec,
    connectionRequirements,
  }
}

/**
 * Validate and type an untrusted parsed JSON object as an {@link ApiToolPackage}.
 *
 * Performs minimal structural validation — enough to guard the import route
 * against obviously malformed payloads without duplicating full Zod schema
 * overhead for what is intentionally a lightweight format.
 *
 * @param raw - Untrusted value (typically `JSON.parse` output).
 * @returns The same object cast to {@link ApiToolPackage}.
 * @throws {Error} When the marker is missing/false or apiSpec is malformed.
 */
export function parseApiToolPackage(raw: unknown): ApiToolPackage {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid .cmapi: not an object')
  const obj = raw as Record<string, unknown>
  if (obj[API_TOOL_PACKAGE_MARKER] !== true) throw new Error('Invalid .cmapi: missing marker')
  const apiSpec = obj.apiSpec as ApiToolSpec | undefined
  if (
    !apiSpec ||
    typeof apiSpec !== 'object' ||
    typeof apiSpec.pre !== 'string' ||
    typeof apiSpec.post !== 'string' ||
    !apiSpec.request
  ) {
    throw new Error('Invalid .cmapi: missing or malformed apiSpec')
  }
  return obj as unknown as ApiToolPackage
}

/**
 * Apply a `{oldConnId: newConnId}` mapping to the package's apiSpec.
 *
 * Delegates to {@link applyConnectionMapping} — all connection ids referenced in
 * `pre`, `post`, and `request.connectionId` that appear in `mapping` are rewritten.
 *
 * @param pkg - The source {@link ApiToolPackage}.
 * @param mapping - Map of old connection id to new connection id.
 * @returns A new {@link ApiToolSpec} with all mapped ids replaced.
 */
export function rebuildApiSpecFromPackage(
  pkg: ApiToolPackage,
  mapping: Record<string, string>
): ApiToolSpec {
  return applyConnectionMapping(pkg.apiSpec, mapping)
}
