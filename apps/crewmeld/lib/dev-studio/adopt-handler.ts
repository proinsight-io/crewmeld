/**
 * Adopt handler — orchestrates the full pipeline when a user clicks "adopt"
 * in the Tool Dev Studio.
 *
 * New flow (NFS migration, spec §10.1):
 *  1. readManifestFromSession — load `.crewmeld-studio/manifest.json` from
 *     the live workspace.
 *  2. determine toolId — reuse `session.toolId` for re-adopt (iteration),
 *     else mint a fresh uuid.
 *  3. syncWorkspaceToCode — atomic NFS copy from session workspace into
 *     `tools-workspace/<toolId>/code/` with sha256 fingerprint.
 *  4. prewarmDependencies — start a builder sandbox and pip-install missing
 *     libraries into the shared NFS site-packages volume. May throw
 *     {@link AdoptError} on install failures.
 *  5. upsert tools row — convertManifestToTool (no packageKey) + insert or
 *     update; on first adopt also create the default tool_instances row
 *     seeded from manifest env defaults.
 *  6. sessionStore.adopt + destroyContainer — mark session adopted, tear
 *     down the active container best-effort (TTL is the backstop).
 *
 * The MinIO `.cmtool` upload path (spec C `packager.ts`) is gone: code now
 * lives on NFS keyed by toolId.
 */
import { db, toolInstances, tools } from '@crewmeld/db'
import { createLogger } from '@crewmeld/logger'
import { eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { syncWorkspaceToCode } from './code-sync'
import { AdoptError, prewarmDependencies } from './dependency-prewarmer'
import { readManifestFromSession } from './manifest-reader'
import { convertManifestToTool } from './manifest-to-tool'
import { sessionStore } from './session-store'

const logger = createLogger('adopt-handler')

export interface AdoptResult {
  toolId: string
  toolName: string
  isUpdate: boolean
  needsRedeploy: boolean
}

/**
 * Run the full adopt pipeline for a dev-studio session.
 *
 * @param sessionId - The session to adopt.
 * @param userId    - Authenticated user performing the adopt.
 * @returns Summary of what was created/updated.
 * @throws {@link AdoptError} for structured user-facing failures
 *   (manifest-missing, session-not-found, dependency-install-failed, etc.).
 *   The adopt route maps these to HTTP 404 / 422 with the retryable flag.
 */
export async function adoptSession(sessionId: string, userId: string): Promise<AdoptResult> {
  // 1. Read the manifest from the live workspace.
  const manifest = await readManifestFromSession(sessionId)
  if (!manifest) {
    throw new AdoptError(
      'manifest-missing',
      'manifest.json not found in workspace — AI must create it before adopt.',
      false
    )
  }

  // 2. Determine toolId — re-adopt reuses the existing session.toolId.
  const session = await sessionStore.get(sessionId)
  if (!session) {
    throw new AdoptError('session-not-found', 'session does not exist', false)
  }
  const existingToolId = (session.toolId as string | null) ?? null
  const isUpdate = existingToolId !== null
  const toolId = existingToolId ?? nanoid()

  // 3. Atomic NFS sync — workspace → tools-workspace/<toolId>/code/.
  const syncResult = await syncWorkspaceToCode(sessionId, toolId)
  logger.info(
    { sessionId, toolId, sha256: syncResult.sha256, cached: syncResult.cached },
    'workspace synced to NFS code dir'
  )

  // 4. Prewarm pip dependencies. May throw AdoptError (install).
  await prewarmDependencies(toolId, manifest)

  // 5. Upsert the tools row — convertManifestToTool returns the manifest-derived
  //    columns; the caller supplies id/createdBy/timestamps.
  const toolData = convertManifestToTool({ manifest, sha256: syncResult.sha256 })
  let needsRedeploy = false

  if (isUpdate) {
    await db
      .update(tools)
      .set({ ...toolData, updatedAt: new Date() })
      .where(eq(tools.id, toolId))

    // Any running instance backed by this tool needs a redeploy after code change.
    const instances = await db
      .select()
      .from(toolInstances)
      .where(eq(toolInstances.templateId, toolId))
    needsRedeploy = instances.some(
      (i) => (i.deploy as { status?: string } | null)?.status === 'deployed'
    )
    logger.info({ toolId, needsRedeploy }, 'existing tool updated')
  } else {
    await db.insert(tools).values({ id: toolId, ...toolData, createdBy: userId })

    // First adopt also seeds the default tool_instances row from manifest env defaults.
    const instanceId = nanoid()
    const defaultPresetParams: Record<string, string> = {}
    if (manifest.env?.properties) {
      for (const [key, prop] of Object.entries(manifest.env.properties)) {
        if (prop.default != null) {
          defaultPresetParams[key] = String(prop.default)
        }
      }
    }
    await db.insert(toolInstances).values({
      id: instanceId,
      templateId: toolId,
      name: manifest.name,
      presetParams: Object.keys(defaultPresetParams).length > 0 ? defaultPresetParams : null,
      createdBy: userId,
    })
    logger.info({ toolId, instanceId }, 'new tool + default instance created')
  }

  // 6. Mark session adopted. Container teardown is handled by the route layer
  //    (best-effort, AFTER the DB commit) — TTL is the backstop.
  await sessionStore.adopt(sessionId, toolId)

  return { toolId, toolName: manifest.name, isUpdate, needsRedeploy }
}

/**
 * @deprecated Use {@link adoptSession}. Kept as an alias during migration so
 * callers that still import `handleAdopt` continue to compile.
 */
export const handleAdopt = adoptSession
