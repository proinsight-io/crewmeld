/**
 * GET /api/employee/skills/instances/:id/export
 *
 * Export a tool instance as a standalone docker-compose package:
 *   - docker-compose.yml
 *   - .env (with placeholders for secrets)
 *   - tool.cmtool (workspace package — zipped from NFS on the fly)
 *   - README.md (usage instructions)
 *
 * Only supports dev-studio tools (read from NFS via paths.toolCode.forBff).
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { db, toolInstances, tools } from '@crewmeld/db'
import { eq } from 'drizzle-orm'
import JSZip from 'jszip'
import { requirePermission } from '@/lib/auth/rbac/check-permission'
import { resolveConnectionEnvVars } from '@/lib/connectors/resolve-conn-env'
import { readManifestFromTool } from '@/lib/dev-studio/manifest-reader'
import { paths } from '@/lib/dev-studio/paths'
import { generateComposeExport } from '@/lib/tools/compose-exporter'

/** Recursively add directory contents to a JSZip, preserving relative paths. */
async function addDirToZip(zip: JSZip, rootDir: string, relBase = ''): Promise<void> {
  const entries = await fs.readdir(rootDir, { withFileTypes: true })
  for (const ent of entries) {
    const abs = path.join(rootDir, ent.name)
    const rel = relBase ? `${relBase}/${ent.name}` : ent.name
    if (ent.isDirectory()) {
      await addDirToZip(zip, abs, rel)
    } else if (ent.isFile()) {
      const buf = await fs.readFile(abs)
      zip.file(rel, buf)
    }
  }
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requirePermission('skill:read')
  if (!auth.authenticated || auth.error) {
    return new Response('Unauthorized', { status: 401 })
  }

  const { id } = await params

  const [instance] = await db
    .select({
      id: toolInstances.id,
      name: toolInstances.name,
      templateId: toolInstances.templateId,
      connectionId: toolInstances.connectionId,
      envVars: toolInstances.envVars,
      presetParams: toolInstances.presetParams,
    })
    .from(toolInstances)
    .where(eq(toolInstances.id, id))
    .limit(1)

  if (!instance) {
    return new Response('Instance not found', { status: 404 })
  }

  const [template] = await db
    .select({
      source: tools.source,
      envVars: tools.envVars,
    })
    .from(tools)
    .where(eq(tools.id, instance.templateId))
    .limit(1)

  if (template?.source !== 'dev-studio') {
    return new Response('Only dev-studio tools support docker-compose export', { status: 400 })
  }

  // Read manifest directly from NFS.
  const manifest = await readManifestFromTool(instance.templateId)
  if (!manifest) {
    return new Response('manifest.json not found on NFS — has the tool been adopted?', {
      status: 404,
    })
  }

  // Zip the workspace code on the fly to produce a .cmtool blob compatible
  // with the existing docker-compose runtime template.
  const codeDir = paths.toolCode.forBff(instance.templateId)
  const cmtoolZip = new JSZip()
  await addDirToZip(cmtoolZip, codeDir)
  const cmtoolBytes = await cmtoolZip.generateAsync({ type: 'nodebuffer' })

  // Merge env vars: template defaults < connection < instance overrides.
  const envMap = new Map<string, string>()
  if (instance.connectionId) {
    try {
      const connEnv = await resolveConnectionEnvVars(instance.connectionId)
      for (const [k, v] of Object.entries(connEnv)) envMap.set(k, v)
    } catch {
      /* non-fatal */
    }
  }
  const templateEnv = (template.envVars as Array<{ name: string; value: string }> | null) ?? []
  const instanceEnv = (instance.envVars as Array<{ name: string; value: string }> | null) ?? []
  for (const e of templateEnv) envMap.set(e.name, e.value ?? '')
  for (const e of instanceEnv) envMap.set(e.name, e.value ?? '')
  const mergedEnvVars = [...envMap.entries()].map(([name, value]) => ({ name, value }))

  const composeFiles = generateComposeExport({
    instanceId: instance.id,
    instanceName: instance.name,
    manifest,
    envVars: mergedEnvVars,
  })

  const exportZip = new JSZip()
  exportZip.file('docker-compose.yml', composeFiles['docker-compose.yml'])
  exportZip.file('.env', composeFiles['.env'])
  exportZip.file('tool.cmtool', cmtoolBytes)
  exportZip.file('README.md', composeFiles['README.md'])

  const zipBuffer = await exportZip.generateAsync({ type: 'nodebuffer' })
  const filename = `${instance.name}-docker.zip`
  return new Response(zipBuffer as unknown as BodyInit, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(filename)}"`,
    },
  })
}
