/**
 * POST /api/employee/skills/import-cmtool
 *
 * Import a .cmtool package (dev-studio workspace zip).
 *
 * Accepts multipart/form-data with a single `file` field containing the
 * .cmtool zip. The flow mirrors the dev-studio adopt handler but starts from
 * an uploaded artifact instead of a live session:
 *   1. Buffer the upload, enforce size cap, compute sha256.
 *   2. Upload the zip bytes to MinIO under `imported/<sha256>.cmtool`.
 *   3. Read `.crewmeld-studio/manifest.json` from inside the zip and validate
 *      it against the canonical Manifest schema.
 *   4. Insert a new `tools` row (fresh id) + a default `tool_instances` row
 *      whose presetParams are seeded from manifest env defaults.
 *
 * The imported tool is always treated as a new copy — no name- or sha-based
 * deduplication. Users delete the previous template explicitly if they want
 * to replace it.
 */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import { PutObjectCommand } from '@aws-sdk/client-s3'
import { db, toolInstances, tools } from '@crewmeld/db'
import { createLogger } from '@crewmeld/logger'
import { eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import type { NextRequest } from 'next/server'
import unzipper from 'unzipper'
import { apiAuthErr, apiErr, apiOk } from '@/lib/api/response'
import { withAudit } from '@/lib/audit/with-audit'
import { requirePermission } from '@/lib/auth/rbac/check-permission'
import { MANIFEST_RELATIVE_PATH, Manifest, type ManifestT } from '@/lib/dev-studio/manifest-reader'
import { syncZipToCode } from '@/lib/dev-studio/code-sync'
import { AdoptError, prewarmDependencies } from '@/lib/dev-studio/dependency-prewarmer'
import { convertManifestToTool } from '@/lib/dev-studio/manifest-to-tool'
import { paths } from '@/lib/dev-studio/paths'
import {
  ensureToolPackagesBucket,
  MAX_ZIP_SIZE_BYTES,
  TOOL_PACKAGES_BUCKET,
} from '@/lib/dev-studio/packager'
import { getMinioClient } from '@/lib/storage/minio-client'
import type { SkillPackage } from '@/app/(employee)/skills/types'

const logger = createLogger('import-cmtool')

function rowToSkill(row: typeof tools.$inferSelect): SkillPackage {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    version: row.version,
    size: '0 KB',
    uploadedAt: row.createdAt.toISOString().slice(0, 10),
    source: row.source as SkillPackage['source'],
    category: row.category ?? undefined,
    author: row.author ?? undefined,
    url: row.url ?? undefined,
    parameters: row.parameters as SkillPackage['parameters'],
    code: row.code ?? undefined,
    presetParams: row.presetParams as SkillPackage['presetParams'],
    language: (row.language as SkillPackage['language']) ?? 'javascript',
    deploy: row.deploy as SkillPackage['deploy'],
    envVars: row.envVars as SkillPackage['envVars'],
    apiDoc: row.apiDoc ?? undefined,
    connectorType: row.connectorType as SkillPackage['connectorType'],
    needsFileMount: row.needsFileMount ?? false,
  }
}

async function _POST(request: NextRequest) {
  const auth = await requirePermission('skill:create')
  if (!auth.authenticated || auth.error) {
    return apiAuthErr(auth)
  }

  const form = await request.formData()
  const file = form.get('file')
  if (!(file instanceof File) || file.size === 0) {
    return apiErr('api.skill.importNoFile', { status: 400 })
  }
  if (file.size > MAX_ZIP_SIZE_BYTES) {
    return apiErr('api.skill.importTooLarge', {
      status: 413,
      params: { maxMb: Math.floor(MAX_ZIP_SIZE_BYTES / (1024 * 1024)) },
    })
  }

  const zipBytes = Buffer.from(await file.arrayBuffer())
  const sha256 = crypto.createHash('sha256').update(zipBytes).digest('hex')

  // Read and validate manifest before touching storage so a bad upload never
  // leaves orphan objects in MinIO.
  let manifest: ManifestT
  try {
    const dir = await unzipper.Open.buffer(zipBytes)
    const manifestEntry = dir.files.find((f) => f.path === MANIFEST_RELATIVE_PATH)
    if (!manifestEntry) {
      return apiErr('api.skill.importManifestMissing', { status: 400 })
    }
    const manifestText = (await manifestEntry.buffer()).toString('utf-8')
    manifest = Manifest.parse(JSON.parse(manifestText))
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'cmtool manifest parse failed')
    return apiErr('api.skill.importManifestInvalid', { status: 400 })
  }

  // Upload zip to MinIO. Key namespaced under `imported/` so it doesn't
  // collide with dev-studio session keys (`<sessionId>/<sha>.cmtool`).
  const s3Key = `imported/${sha256}.cmtool`
  try {
    await ensureToolPackagesBucket()
    await getMinioClient().send(
      new PutObjectCommand({
        Bucket: TOOL_PACKAGES_BUCKET,
        Key: s3Key,
        Body: zipBytes,
        ContentType: 'application/zip',
      })
    )
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'minio upload failed')
    return apiErr('api.skill.importFailed', { status: 500 })
  }

  // Build tool record from manifest (reuses adopt-handler conversion).
  // After NFS migration `convertManifestToTool` no longer accepts a MinIO
  // s3Key; the import-cmtool flow still writes the zip to MinIO for the
  // legacy skills routes that consume it, but the tools row only carries
  // packageSha256. createdBy is supplied here by the caller.
  const toolData = convertManifestToTool({ manifest, sha256 })

  const toolId = nanoid()
  const now = new Date()

  // Extract the workspace code onto NFS (tools-workspace/<toolId>/code/) so the
  // tool can later be deployed (上架): deployCmtoolSkill requires start.sh +
  // .crewmeld-studio/manifest.json there. Adopt does this for live sessions via
  // syncWorkspaceToCode; an imported package has no adopt step, so this is its
  // only path to NFS. Done before the DB insert and rolled back on failure.
  try {
    await syncZipToCode(toolId, zipBytes, sha256)
  } catch (err) {
    logger.error({ err: (err as Error).message, toolId }, 'cmtool NFS code sync failed')
    return apiErr('api.skill.importFailed', { status: 500 })
  }

  // Install manifest.dependencies.libraries into the shared site-packages volume,
  // mirroring the adopt flow (prewarmDependencies). Without this an imported
  // service/script tool deploys against an empty shared site-packages and fails at
  // runtime (ModuleNotFoundError / never opens its port). Empty libraries return
  // immediately. On failure roll back the NFS code dir and skip the insert, so a
  // half-imported tool that can't be deployed never lands in the table.
  try {
    await prewarmDependencies(toolId, manifest)
  } catch (err) {
    await fs.rm(paths.toolCode.forBff(toolId), { recursive: true, force: true }).catch(() => {})
    if (err instanceof AdoptError) {
      logger.error({ err: err.detail, toolId }, 'cmtool dependency prewarm failed')
      return apiErr('api.skill.importDepsFailed', { status: 422 })
    }
    logger.error({ err: (err as Error).message, toolId }, 'cmtool dependency prewarm error')
    return apiErr('api.skill.importFailed', { status: 500 })
  }

  try {
    await db
      .insert(tools)
      .values({ id: toolId, ...toolData, createdBy: auth.userId!, createdAt: now, updatedAt: now })

    const defaultPresetParams: Record<string, string> = {}
    if (manifest.env?.properties) {
      for (const [key, prop] of Object.entries(manifest.env.properties)) {
        if (prop.default != null) {
          defaultPresetParams[key] = String(prop.default)
        }
      }
    }
    await db.insert(toolInstances).values({
      id: nanoid(),
      templateId: toolId,
      name: manifest.name,
      presetParams: Object.keys(defaultPresetParams).length > 0 ? defaultPresetParams : null,
      createdBy: auth.userId!,
      createdAt: now,
      updatedAt: now,
    })
  } catch (err) {
    logger.error({ err: (err as Error).message, toolId }, 'tool insert failed')
    // Roll back the NFS code dir so a failed import leaves no orphan workspace.
    await fs.rm(paths.toolCode.forBff(toolId), { recursive: true, force: true }).catch(() => {})
    return apiErr('api.skill.importFailed', { status: 500 })
  }

  const [inserted] = await db.select().from(tools).where(eq(tools.id, toolId)).limit(1)

  logger.info({ toolId, name: manifest.name, sha256 }, 'cmtool imported')
  return apiOk(null, { extra: { skill: inserted ? rowToSkill(inserted) : null } })
}

export const POST = withAudit(_POST)
