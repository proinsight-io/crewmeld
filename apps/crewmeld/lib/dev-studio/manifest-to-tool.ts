/**
 * Converts a validated ManifestT + workspace sync sha into a tools-table
 * insert record.
 *
 * Pure data-transformation module with no DB / IO dependencies. After the
 * NFS migration the on-disk code lives at
 * `<tools-workspace>/<toolId>/code/` (synced via `code-sync.ts`); the
 * `tools.package_key` column is dropped (Task 3) and the `packageSha256`
 * column now holds the workspace fingerprint produced by
 * `syncWorkspaceToCode`.
 */
import type { SkillLanguage } from '@/app/(employee)/skills/types'
import type { ManifestT } from './manifest-reader'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Input to {@link convertManifestToTool}: the validated manifest plus the
 * workspace fingerprint returned by `syncWorkspaceToCode`.
 */
export interface ConvertManifestInput {
  manifest: ManifestT
  /** SHA-256 hex digest of the synced workspace contents. */
  sha256: string
}

/**
 * Shape returned by `convertManifestToTool` — matches the columns of the
 * `tools` table that the adopt handler will INSERT/UPDATE. The caller is
 * responsible for adding `id`, `createdBy`, `createdAt`, `updatedAt`, and
 * any deploy/preset/env-vars side fields.
 */
export interface ToolInsertRecord {
  name: string
  description: string
  version: string
  /** Always null for package-based tools (code lives on the NFS code dir). */
  code: null
  /** The manifest `input` JSON Schema forwarded verbatim. */
  parameters: Record<string, unknown>
  language: SkillLanguage
  source: 'dev-studio'
  /** Workspace content fingerprint (SHA-256 hex) from `syncWorkspaceToCode`. */
  packageSha256: string
  connectorType?: { type: string; subtype?: string }
  needsFileMount: boolean
  /** Markdown API documentation auto-generated from the manifest. */
  apiDoc: string
}

// ---------------------------------------------------------------------------
// inferLanguage
// ---------------------------------------------------------------------------

/**
 * Infer the primary programming language from an OCI image name.
 *
 * Rules:
 * - Image name contains "python" anywhere → 'python'
 * - Image name contains "node" anywhere → 'javascript'
 * - Anything else (including undefined) → 'python' (safe fallback)
 */
export function inferLanguage(image: string | undefined): SkillLanguage {
  if (!image) return 'python'
  const lower = image.toLowerCase()
  if (lower.includes('python')) return 'python'
  if (lower.includes('node')) return 'javascript'
  return 'python'
}

// ---------------------------------------------------------------------------
// generateApiDoc
// ---------------------------------------------------------------------------

/**
 * Generate a Markdown API document from a validated manifest.
 *
 * Sections:
 * 1. Title + description
 * 2. Call type (service | script) — for service kind includes port / path / method
 * 3. Input parameters table (from `manifest.input`)
 * 4. Environment variables table (from `manifest.env`, when present)
 */
export function generateApiDoc(manifest: ManifestT): string {
  const lines: string[] = []

  // Title and description
  lines.push(`# ${manifest.name}`)
  lines.push('')
  if (manifest.description) {
    lines.push(manifest.description)
    lines.push('')
  }

  // Call type section
  lines.push('## Call Type')
  lines.push('')
  if (manifest.kind === 'service' && manifest.service) {
    const { port, path, method } = manifest.service
    lines.push(`Type: **service**`)
    lines.push('')
    lines.push(`| Field  | Value |`)
    lines.push(`|--------|-------|`)
    lines.push(`| Port   | ${port} |`)
    lines.push(`| Path   | ${path} |`)
    lines.push(`| Method | ${method} |`)
  } else {
    lines.push(`Type: **script**`)
    lines.push('')
    lines.push(`Entrypoint: \`${manifest.entrypoint}\``)
  }
  lines.push('')

  // Input parameters section
  lines.push('## Input Parameters')
  lines.push('')

  const inputProps =
    manifest.input &&
    typeof manifest.input === 'object' &&
    'properties' in manifest.input &&
    manifest.input.properties &&
    typeof manifest.input.properties === 'object'
      ? (manifest.input.properties as Record<string, { type?: string; description?: string }>)
      : {}

  const inputRequired: string[] =
    manifest.input &&
    typeof manifest.input === 'object' &&
    'required' in manifest.input &&
    Array.isArray(manifest.input.required)
      ? (manifest.input.required as string[])
      : []

  const inputKeys = Object.keys(inputProps)
  if (inputKeys.length > 0) {
    lines.push('| Parameter | Type | Required | Description |')
    lines.push('|-----------|------|----------|-------------|')
    for (const key of inputKeys) {
      const prop = inputProps[key]
      const type = prop?.type ?? 'string'
      const desc = prop?.description ?? ''
      const required = inputRequired.includes(key) ? 'yes' : 'no'
      lines.push(`| ${key} | ${type} | ${required} | ${desc} |`)
    }
  } else {
    lines.push('_No input parameters._')
  }
  lines.push('')

  // Environment variables section (optional)
  if (manifest.env?.properties) {
    lines.push('## Environment Variables')
    lines.push('')
    lines.push('| Variable | Type | Required | Description |')
    lines.push('|----------|------|----------|-------------|')

    const envRequired = manifest.env.required ?? []
    for (const [key, prop] of Object.entries(manifest.env.properties)) {
      const type = prop.type
      const desc = prop.description ?? ''
      const required = envRequired.includes(key) ? 'yes' : 'no'
      lines.push(`| ${key} | ${type} | ${required} | ${desc} |`)
    }
    lines.push('')
  }

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// convertManifestToTool
// ---------------------------------------------------------------------------

/**
 * Convert a validated manifest and workspace sync fingerprint into a
 * tools-table record suitable for the adopt handler.
 *
 * The result intentionally excludes `id`, `createdBy`, `createdAt`, and
 * `updatedAt`: those are supplied by the caller (adopt-handler) which knows
 * whether this is an INSERT or an UPDATE.
 */
/**
 * Fold the manifest `env` block into the tool's `parameters` schema as
 * `secret`-flagged properties. The instance editor derives its env-vars form
 * from secret properties in `parameters` (the legacy tool convention), so
 * without this the env vars an AI declared in the separate `manifest.env` block
 * would vanish after adoption (the form would be empty). Env keys are added to
 * `properties` only — never to the input `required` array — so the input form /
 * validation treats them purely as env vars, not input params.
 */
function foldEnvIntoParameters(
  input: Record<string, unknown>,
  env: ManifestT['env']
): Record<string, unknown> {
  if (!env?.properties) return input
  const inputProps =
    typeof input.properties === 'object' && input.properties !== null
      ? (input.properties as Record<string, unknown>)
      : {}
  const envProps: Record<string, unknown> = {}
  for (const [key, prop] of Object.entries(env.properties)) {
    envProps[key] = { ...prop, secret: true }
  }
  return { ...input, properties: { ...inputProps, ...envProps } }
}

export function convertManifestToTool(input: ConvertManifestInput): ToolInsertRecord {
  const { manifest, sha256 } = input
  return {
    name: manifest.name,
    description: manifest.description,
    version: manifest.version,
    code: null,
    parameters: foldEnvIntoParameters(manifest.input as Record<string, unknown>, manifest.env),
    language: inferLanguage(manifest.image),
    source: 'dev-studio',
    packageSha256: sha256,
    connectorType: manifest.connectorType,
    needsFileMount: manifest.needsFileMount,
    apiDoc: generateApiDoc(manifest),
  }
}
