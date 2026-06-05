/**
 * GET /api/employee/skills/:id/export
 *
 * Export a tool template:
 * - dev-studio tools: zip the NFS workspace code (paths.toolCode.forBff) on the fly
 * - Inline code tools: generate a zip with manifest.json + tool.js/tool.py
 *
 * Refs spec 2026-05-28 §7.1 (MinIO removed; code lives on NFS).
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { db, tools } from '@crewmeld/db'
import { eq } from 'drizzle-orm'
import JSZip from 'jszip'
import { requirePermission } from '@/lib/auth/rbac/check-permission'
import { paths } from '@/lib/dev-studio/paths'

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
  const [tool] = await db
    .select({
      id: tools.id,
      name: tools.name,
      description: tools.description,
      version: tools.version,
      source: tools.source,
      language: tools.language,
      code: tools.code,
      parameters: tools.parameters,
      presetParams: tools.presetParams,
      envVars: tools.envVars,
      apiDoc: tools.apiDoc,
      connectorType: tools.connectorType,
    })
    .from(tools)
    .where(eq(tools.id, id))
    .limit(1)

  if (!tool) {
    return new Response('Not Found', { status: 404 })
  }

  // dev-studio tools: zip the workspace code directly from NFS.
  if (tool.source === 'dev-studio') {
    const codeDir = paths.toolCode.forBff(tool.id)
    try {
      await fs.access(codeDir)
    } catch {
      return new Response(
        `Tool code not found on NFS at ${codeDir} — has it been adopted?`,
        { status: 404 }
      )
    }
    const zip = new JSZip()
    await addDirToZip(zip, codeDir)
    const zipBytes = await zip.generateAsync({ type: 'nodebuffer' })
    const filename = `${tool.name}.cmtool`
    return new Response(zipBytes as unknown as BodyInit, {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(filename)}"`,
      },
    })
  }

  // Inline code tools: generate manifest + code zip
  const zip = new JSZip()
  const manifest = {
    _crewmeld_export: true,
    id: tool.id,
    name: tool.name,
    description: tool.description,
    version: tool.version,
    source: tool.source,
    language: tool.language ?? 'javascript',
    parameters: tool.parameters,
    presetParams: tool.presetParams,
    envVars: (tool.envVars as Array<{ name: string }> | null)?.map((e) => ({ name: e.name, value: '' })),
    apiDoc: tool.apiDoc,
    connectorType: tool.connectorType,
  }
  zip.file('manifest.json', JSON.stringify(manifest, null, 2))

  if (tool.code) {
    const ext = (tool.language ?? 'javascript') === 'python' ? 'py' : 'js'
    zip.file(`tool.${ext}`, tool.code)
  }

  const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' })
  const filename = `${tool.name}.zip`
  return new Response(zipBuffer as unknown as BodyInit, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(filename)}"`,
    },
  })
}
