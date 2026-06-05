/**
 * Tool Dev Studio manifest reader/writer (Sub-spec B §4.2).
 *
 * The manifest is the AI-generated contract describing what the tool does,
 * how to invoke it, and what dependencies it requires. It lives at
 * `.crewmeld-studio/manifest.json` inside the per-session workspace.
 *
 * This module:
 * - Defines the canonical Zod schema (`Manifest`) for runtime validation.
 * - Exposes non-throwing readers (`readManifestFromSession` /
 *   `readManifestFromTool`, returning `null` when absent) and a strict
 *   `patchManifestFromSession` that refuses to materialize a manifest the
 *   AI never created — preventing accidental "auto-resurrection" of a
 *   deleted workspace.
 * - Writes atomically via `.tmp + rename` to avoid half-written files when
 *   the caller is killed mid-flush.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { paths } from './paths'

/** Relative path of the manifest inside a session workspace. */
export const MANIFEST_RELATIVE_PATH = '.crewmeld-studio/manifest.json' as const

/**
 * Relative path of the pip requirements file at the workspace root. Kept in
 * lock-step with `manifest.dependencies.libraries` by {@link setManifestLibraries}
 * — the persona protocol requires the two to match exactly or the downstream
 * libs builder fails.
 */
export const REQUIREMENTS_RELATIVE_PATH = 'requirements.txt' as const

/**
 * OCI image reference: registry[:port][/repo][:tag][@digest].
 *
 * Permissive — accepts common forms including:
 *   - python:3.12-slim
 *   - docker.io/library/python:3.12-slim
 *   - localhost:5000/myimage:v1
 *   - quay.io/foo/bar:tag@sha256:<64-hex>
 *
 * The registry component (before the first `/`) accepts uppercase letters and an
 * optional :port (OCI spec is technically case-insensitive at the registry level).
 * The repository component (after the first `/`) is lowercase-only per OCI spec.
 */
const OCI_IMAGE_RE =
  /^[a-zA-Z0-9][a-zA-Z0-9._\-]*(:[0-9]+)?(\/[a-z0-9][a-z0-9._\-/]*)?(:[a-zA-Z0-9._\-]+)?(@sha256:[a-f0-9]{64})?$/

/** Shell env var name: letter/underscore + alphanum/underscore. */
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Single environment variable declaration inside the manifest `env` block.
 *
 * Mirrors a minimal subset of JSON Schema so the operator UI can render a
 * form (text input, number input, checkbox, masked password field). The
 * `format: 'password'` hint instructs the UI to render a masked input.
 */
const EnvPropSchema = z.object({
  type: z.enum(['string', 'integer', 'number', 'boolean']),
  description: z.string().optional(),
  default: z.unknown().optional(),
  format: z.literal('password').optional(),
  minimum: z.number().optional(),
  maximum: z.number().optional(),
})

/**
 * The manifest `env` block — a JSON-Schema-shaped declaration of the
 * environment variables the tool consumes at runtime. Property keys must be
 * valid shell identifiers (`[A-Za-z_][A-Za-z0-9_]*`) so they can be exported
 * directly into the container env without rewriting.
 */
const EnvSchema = z.object({
  type: z.literal('object'),
  required: z.array(z.string()).optional(),
  properties: z.record(z.string().regex(ENV_KEY_RE), EnvPropSchema),
})

/**
 * Kubernetes-style resource requests/limits. All sub-fields are optional
 * strings using the standard quantity format (`100m`, `512Mi`, `1Gi`); the
 * deployer is responsible for fielding/normalizing them downstream.
 */
const ResourcesSchema = z
  .object({
    requests: z
      .object({
        cpu: z.string().optional(),
        memory: z.string().optional(),
        'ephemeral-storage': z.string().optional(),
      })
      .optional(),
    limits: z
      .object({
        cpu: z.string().optional(),
        memory: z.string().optional(),
        'ephemeral-storage': z.string().optional(),
      })
      .optional(),
  })
  .optional()

/**
 * Hint that classifies the tool by integration category (e.g. `database` /
 * `mysql`, `messaging` / `slack`). Purely informational — used by the
 * operator UI to group tools and select appropriate icons; the runtime does
 * not switch behavior on these values.
 */
const ConnectorTypeSchema = z.preprocess(
  // Tolerate the common model mistake of emitting `"connectorType": "database"`
  // (a bare string) instead of the object form — coerce it to `{ type }` so a
  // single wrong shape doesn't 422 the entire manifest. Subtype is lost in that
  // case (the connection picker then lists all connections of that type).
  (value) => (typeof value === 'string' ? { type: value } : value),
  z.object({
    type: z.string().min(1),
    subtype: z.string().optional(),
  })
)

/**
 * Canonical Zod schema for `.crewmeld-studio/manifest.json`.
 *
 * The `kind === 'service'` branch requires a `service` field; this is
 * enforced via a refinement rather than a discriminated union because the
 * `kind` field carries its own default which would otherwise short-circuit
 * the union resolution.
 */
export const Manifest = z
  .object({
    version: z.string(),
    name: z.string().min(1).max(60),
    description: z.string().max(500).default(''),
    kind: z.enum(['script', 'service']).default('script'),
    entrypoint: z.string().min(1),
    image: z.string().regex(OCI_IMAGE_RE).optional(),
    resources: ResourcesSchema,
    service: z
      .object({
        port: z.number().int().min(1).max(65535),
        path: z.string().regex(/^\//),
        method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']).default('POST'),
      })
      .optional(),
    dependencies: z
      .object({
        libraries: z.array(z.string()).default([]),
        domains: z.array(z.string()).default([]),
        /**
         * Per-tool egress IPs/CIDRs (operator-managed, edited pre-listing).
         * Unlike `domains` these are NOT FQDN-validated — raw IPs/CIDRs are the
         * point. Folded into the egress allow-list in allowlist mode.
         */
        ips: z.array(z.string()).default([]),
      })
      .default({ libraries: [], domains: [], ips: [] }),
    /**
     * Packaging manifest — every workspace file/directory the tool needs at
     * runtime. Paths are relative to /root/workspace. Used by the downstream
     * packaging step (E phase) to tar exactly these entries into the deploy
     * zip; anything outside this list is dropped. Should include source
     * files, init.sh, requirements.txt, resource files, and any subdirs.
     * The synthetic `.crewmeld-studio/` triplet (manifest.json + README.md +
     * start.sh) is added automatically by the packager and need not appear
     * here.
     */
    files: z.array(z.string()).default([]),
    env: EnvSchema.optional(),
    connectorType: ConnectorTypeSchema.optional(),
    /**
     * Whether this tool needs a per-execution IO directory mounted at /root/io.
     * Tools that read uploaded files or produce output files (images, PDFs, CSVs)
     * should set this to true. The SOP executor passes the execution ID so each
     * invocation gets an isolated IO workspace.
     */
    needsFileMount: z.boolean().default(false),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    input: z.record(z.unknown()),
    output: z.discriminatedUnion('type', [
      z.object({ type: z.literal('files'), dir: z.string() }),
      z.object({ type: z.literal('json'), schema: z.record(z.unknown()).optional() }),
      z.object({ type: z.literal('text') }),
      z.object({ type: z.literal('image') }),
      z.object({ type: z.literal('pdf') }),
    ]),
    auth: z
      .object({
        type: z.enum(['api-key', 'none']),
        header: z.string().optional(),
      })
      .optional(),
  })
  .refine((m) => m.kind !== 'service' || m.service !== undefined, {
    message: 'kind=service requires service field',
  })
  .refine(
    (m) => {
      // Tools that don't mount /root/io can't have file inputs at all.
      if (!m.needsFileMount) return true
      // Output-only file tools (e.g. report generators) are fine — they
      // produce files but don't read any. Skip the check when output.type
      // declares files / image / pdf so those manifests aren't rejected.
      const outputType = (m.output as { type: string } | undefined)?.type
      if (outputType === 'files' || outputType === 'image' || outputType === 'pdf') {
        // Even so, if the tool also accepts a user-uploaded input file we
        // want format:"file" on it. We only skip the require-at-least-one
        // check below; a malformed file field (string without format) is
        // still spotted by the persona self-check. The safest path is to
        // still require at least one file field when input.properties is
        // present and contains any field whose name screams "file".
        const props = ((m.input as { properties?: Record<string, unknown> } | undefined)?.properties ?? {}) as Record<string, unknown>
        const looksLikeFileField = Object.keys(props).some((k) =>
          /(file(name)?|filepath|file_path|input_file|upload)/i.test(k)
        )
        if (!looksLikeFileField) return true
      }
      const props = ((m.input as { properties?: Record<string, unknown> } | undefined)?.properties ?? {}) as Record<string, unknown>
      if (Object.keys(props).length === 0) return true
      return Object.values(props).some((p) => {
        return (
          typeof p === 'object' &&
          p !== null &&
          (p as { format?: unknown }).format === 'file'
        )
      })
    },
    {
      message:
        'needsFileMount=true but no input.properties field has format:"file". ' +
        'A field representing a user-uploaded file must be declared as ' +
        '{ "type": "string", "format": "file", "title": "...", "description": "..." }; ' +
        'otherwise the UI does not render the upload control and the operator cannot upload files during testing. ' +
        'Fix: add "format": "file" to the relevant input field(s) and re-save the manifest.',
    }
  )

export type ManifestT = z.infer<typeof Manifest>

/** Subset of manifest fields the operator UI is allowed to patch. */
export type ManifestPatch = Partial<Pick<ManifestT, 'name' | 'description'>>

/**
 * Read and validate the manifest at
 * `<sessionWorkspace>/.crewmeld-studio/manifest.json` for a given session.
 *
 * Derives the workspace via `paths.sessionWorkspace.forBff(sessionId)`.
 *
 * @returns The parsed manifest, or `null` when the file does not exist.
 * @throws When the file exists but is malformed JSON or fails Zod validation.
 */
export async function readManifestFromSession(sessionId: string): Promise<ManifestT | null> {
  return readManifestFromDir(paths.sessionWorkspace.forBff(sessionId))
}

/**
 * Read and validate the manifest at
 * `<toolCodeDir>/.crewmeld-studio/manifest.json` for a given adopted tool.
 *
 * Used by the deploy path (spec §11.2) which reads the manifest out of the
 * tool's persistent code directory rather than a session workspace.
 *
 * @returns The parsed manifest, or `null` when the file does not exist.
 * @throws When the file exists but is malformed JSON or fails Zod validation.
 */
export async function readManifestFromTool(toolId: string): Promise<ManifestT | null> {
  return readManifestFromDir(paths.toolCode.forBff(toolId))
}

/**
 * Merge `patch` into the manifest located at the given session's workspace
 * and atomically persist it.
 *
 * @throws When the manifest file does not yet exist — callers must let the
 *   AI create it first (string prefix: `CONFLICT:`).
 */
export async function patchManifestFromSession(
  sessionId: string,
  patch: ManifestPatch
): Promise<ManifestT> {
  return patchManifestInDir(paths.sessionWorkspace.forBff(sessionId), patch)
}

/**
 * Replace `dependencies.libraries` in the session's manifest and mirror the
 * list into the workspace `requirements.txt`, keeping the two in lock-step.
 *
 * Domains and all other fields are preserved; `updatedAt` is bumped. The
 * manifest is written atomically (`.tmp` + rename). When `libraries` is empty
 * the requirements file is removed so a stale list can never linger.
 *
 * @throws When the manifest does not yet exist (prefix `CONFLICT:`) — the AI
 *   must create it first, mirroring {@link patchManifestFromSession}.
 */
export async function setManifestLibraries(
  sessionId: string,
  libraries: string[]
): Promise<ManifestT> {
  const workspaceDir = paths.sessionWorkspace.forBff(sessionId)
  const current = await readManifestFromDir(workspaceDir)
  if (!current) {
    throw new Error('CONFLICT: manifest does not exist; AI must create it first')
  }

  const next: ManifestT = {
    ...current,
    dependencies: { ...current.dependencies, libraries },
    updatedAt: new Date().toISOString(),
  }
  await writeManifestAtomic(workspaceDir, next)

  const reqPath = path.join(workspaceDir, REQUIREMENTS_RELATIVE_PATH)
  if (libraries.length > 0) {
    await fs.writeFile(reqPath, `${libraries.join('\n')}\n`, 'utf-8')
  } else {
    await fs.rm(reqPath, { force: true })
  }
  return next
}

/**
 * Replace the egress allow-list (`dependencies.domains` + `dependencies.ips`)
 * in an adopted tool's manifest (read from the tool code dir, not a session).
 * Libraries and all other fields are preserved; `updatedAt` is bumped. Written
 * atomically. Used by the instance-edit egress editor (Sub-spec C, Model A).
 *
 * @throws When the manifest does not exist (prefix `CONFLICT:`).
 */
export async function setToolManifestEgress(
  toolId: string,
  egress: { domains: string[]; ips: string[] }
): Promise<ManifestT> {
  const workspaceDir = paths.toolCode.forBff(toolId)
  const current = await readManifestFromDir(workspaceDir)
  if (!current) {
    throw new Error('CONFLICT: manifest does not exist; cannot edit egress')
  }

  const next: ManifestT = {
    ...current,
    dependencies: {
      ...current.dependencies,
      domains: egress.domains,
      ips: egress.ips,
    },
    updatedAt: new Date().toISOString(),
  }
  await writeManifestAtomic(workspaceDir, next)
  return next
}

async function readManifestFromDir(workspaceDir: string): Promise<ManifestT | null> {
  const fp = path.join(workspaceDir, MANIFEST_RELATIVE_PATH)
  let raw: string
  try {
    raw = await fs.readFile(fp, 'utf-8')
  } catch (err: unknown) {
    if (isEnoent(err)) return null
    throw err
  }
  const parsed = JSON.parse(raw) as unknown
  await overrideTimestampsInPlace(parsed, fp)
  return Manifest.parse(parsed)
}

/**
 * Override `createdAt` / `updatedAt` on a parsed manifest object using the
 * filesystem mtime at `mtimeSourcePath`, in place.
 *
 * The AI commonly fabricates these timestamps (it doesn't know server time
 * and tends to write a stale ISO string from its training distribution —
 * "Updated 4 hours ago" on a brand-new session is the tell).
 * Authoritatively replace both timestamps with the filesystem mtime so the
 * UI shows actual edit time. Called before Zod validation so the schema
 * sees consistent values; on-disk content is untouched.
 *
 * When the stat call fails (e.g. host cannot reach the sandbox's
 * bind-mounted directory in local dev, or a race vs. removal), we fall
 * back to "now" — still a lie, but a useful one: a freshly-fetched
 * manifest reads as "just now" instead of the AI's invented 4-hour-ago
 * timestamp.
 */
export async function overrideTimestampsInPlace(
  parsed: unknown,
  mtimeSourcePath: string
): Promise<void> {
  if (!parsed || typeof parsed !== 'object') return
  const obj = parsed as Record<string, unknown>
  let mtimeIso: string
  let mtimeMs: number
  try {
    const stat = await fs.stat(mtimeSourcePath)
    mtimeIso = stat.mtime.toISOString()
    mtimeMs = stat.mtime.getTime()
  } catch {
    const now = new Date()
    mtimeIso = now.toISOString()
    mtimeMs = now.getTime()
  }
  obj.updatedAt = mtimeIso
  // Preserve a caller-supplied createdAt when it's a sane ISO not in the
  // future relative to mtime; otherwise fall back to mtime so the field
  // never lies.
  const ca = obj.createdAt
  const caMs = typeof ca === 'string' ? Date.parse(ca) : Number.NaN
  if (!Number.isFinite(caMs) || caMs > mtimeMs) {
    obj.createdAt = mtimeIso
  }
}

async function patchManifestInDir(
  workspaceDir: string,
  patch: ManifestPatch
): Promise<ManifestT> {
  const current = await readManifestFromDir(workspaceDir)
  if (!current) {
    throw new Error('CONFLICT: manifest does not exist; AI must create it first')
  }

  const next: ManifestT = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  }

  await writeManifestAtomic(workspaceDir, next)
  return next
}

/** Atomically persist a manifest via `.tmp` + rename to avoid torn writes. */
async function writeManifestAtomic(workspaceDir: string, manifest: ManifestT): Promise<void> {
  const fp = path.join(workspaceDir, MANIFEST_RELATIVE_PATH)
  const tmp = `${fp}.tmp`
  await fs.writeFile(tmp, JSON.stringify(manifest, null, 2), 'utf-8')
  try {
    await fs.rename(tmp, fp)
  } catch (err) {
    await fs.unlink(tmp).catch(() => {})
    throw err
  }
}

/** Narrow helper — Node's fs errors carry `code` on the thrown object. */
function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ENOENT'
}
