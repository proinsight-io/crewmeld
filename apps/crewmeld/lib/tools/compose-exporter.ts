/**
 * Generate a standalone docker-compose export for a tool instance.
 *
 * The export zip contains:
 *   - docker-compose.yml   (init container + tool container)
 *   - .env                 (merged env vars with placeholders for secrets)
 *   - tool.cmtool          (the packaged workspace zip)
 *   - README.md            (usage instructions)
 */

import type { ManifestT } from '@/lib/dev-studio/manifest-reader'

const DEFAULT_IMAGE = 'python:3.12-slim'

export interface ComposeExportParams {
  instanceId: string
  instanceName: string
  manifest: ManifestT
  envVars: Array<{ name: string; value: string }>
}

export interface ComposeExportFiles {
  'docker-compose.yml': string
  '.env': string
  'README.md': string
}

export function generateComposeExport(params: ComposeExportParams): ComposeExportFiles {
  const { instanceId, instanceName, manifest, envVars } = params
  const image = manifest.image ?? DEFAULT_IMAGE
  const kind = manifest.kind ?? 'script'
  const volumeName = `crewmeld-tool-${instanceId}`

  const compose = buildComposeYml(instanceId, instanceName, image, kind, manifest, volumeName)
  const dotenv = buildDotEnv(envVars, manifest)
  const readme = buildReadme(instanceName, kind, manifest)

  return { 'docker-compose.yml': compose, '.env': dotenv, 'README.md': readme }
}

function buildComposeYml(
  instanceId: string,
  instanceName: string,
  image: string,
  kind: string,
  manifest: ManifestT,
  volumeName: string
): string {
  const lines: string[] = []
  const safeComment = instanceName.replace(/[^\x20-\x7E一-鿿]/g, '')

  lines.push(`# ${safeComment} — exported from CrewMeld`)
  lines.push('')
  lines.push('services:')

  // init container: extract .cmtool + run init.sh
  lines.push('  init:')
  lines.push(`    image: ${image}`)
  lines.push('    volumes:')
  lines.push(`      - tool-code:/root/workspace`)
  lines.push('      - pip-cache:/root/.cache/pip')
  lines.push('      - ./tool.cmtool:/root/workspace/tool.cmtool:ro')
  lines.push('    env_file: .env')
  lines.push('    command: >-')
  lines.push(`      bash -c "`)
  lines.push(`      cd /root/workspace &&`)
  lines.push(`      python3 -c 'import zipfile; z=zipfile.ZipFile(\\\"tool.cmtool\\\"); z.extractall(\\\".\\\")' &&`)
  lines.push(`      rm -f tool.cmtool &&`)
  lines.push(`      ([ -f requirements.txt ] && pip install -r requirements.txt; true) &&`)
  lines.push(`      ([ -f init.sh ] && bash init.sh; true)`)
  lines.push(`      "`)
  lines.push('')

  // tool container
  lines.push('  tool:')
  lines.push(`    image: ${image}`)
  lines.push('    depends_on:')
  lines.push('      init:')
  lines.push('        condition: service_completed_successfully')
  lines.push('    volumes:')
  lines.push(`      - tool-code:/root/workspace:ro`)
  lines.push('    env_file: .env')

  if (kind === 'service' && manifest.service) {
    const port = manifest.service.port
    lines.push('    ports:')
    lines.push(`      - "\${HOST_PORT:-${port}}:${port}"`)
    lines.push(`    command: bash -c "cd /root/workspace && bash start.sh"`)
  } else {
    lines.push('    stdin_open: true')
    lines.push(`    entrypoint: ["bash", "-c", "cd /root/workspace && bash start.sh"]`)
  }

  if (manifest.needsFileMount) {
    lines.push('    # IO directory for file-based tools')
    lines.push('    # volumes:')
    lines.push('    #   - ./io:/root/io')
  }

  lines.push('')
  lines.push('volumes:')
  lines.push('  tool-code:')
  lines.push(`    name: ${volumeName}`)
  lines.push('  pip-cache:')
  lines.push('    name: crewmeld-pip-cache')
  lines.push('')

  return lines.join('\n')
}

function buildDotEnv(
  envVars: Array<{ name: string; value: string }>,
  manifest: ManifestT
): string {
  const lines: string[] = []
  lines.push('# Environment variables for the tool')
  lines.push('# Fill in secret values marked with <FILL_IN>')
  lines.push('')

  const seen = new Set<string>()

  for (const e of envVars) {
    if (seen.has(e.name)) continue
    seen.add(e.name)
    const isSecret = manifest.env?.properties?.[e.name]?.format === 'password'
    const value = isSecret && !e.value ? '<FILL_IN>' : e.value
    const desc = manifest.env?.properties?.[e.name]?.description
    if (desc) lines.push(`# ${desc}`)
    lines.push(`${e.name}=${value}`)
  }

  if (manifest.env?.properties) {
    for (const [key, prop] of Object.entries(manifest.env.properties)) {
      if (seen.has(key)) continue
      seen.add(key)
      if (prop.description) lines.push(`# ${prop.description}`)
      const def = prop.default !== undefined && prop.default !== null ? String(prop.default) : ''
      const isSecret = prop.format === 'password'
      lines.push(`${key}=${isSecret && !def ? '<FILL_IN>' : def}`)
    }
  }

  lines.push('')
  return lines.join('\n')
}

function buildReadme(instanceName: string, kind: string, manifest: ManifestT): string {
  const lines: string[] = []
  lines.push(`# ${instanceName}`)
  lines.push('')
  if (manifest.description) {
    lines.push(manifest.description)
    lines.push('')
  }
  lines.push('## Quick Start')
  lines.push('')
  lines.push('1. Edit `.env`, fill in secret values marked with `<FILL_IN>`')
  lines.push('2. Run:')
  lines.push('```bash')
  lines.push('docker compose up')
  lines.push('```')
  lines.push('')

  if (kind === 'service' && manifest.service) {
    lines.push(`3. Service is available at \`http://localhost:\${HOST_PORT:-${manifest.service.port}}${manifest.service.path}\``)
    lines.push('')
    lines.push('Example:')
    lines.push('```bash')
    lines.push(`curl -X ${manifest.service.method ?? 'POST'} http://localhost:${manifest.service.port}${manifest.service.path} \\`)
    lines.push(`  -H "Content-Type: application/json" \\`)
    lines.push(`  -d '{"key": "value"}'`)
    lines.push('```')
  } else {
    lines.push('3. Send JSON to stdin:')
    lines.push('```bash')
    lines.push(`echo '{"key": "value"}' | docker compose run --rm tool`)
    lines.push('```')
  }

  lines.push('')
  lines.push('## Clean Up')
  lines.push('')
  lines.push('```bash')
  lines.push('docker compose down -v')
  lines.push('```')
  lines.push('')
  lines.push('---')
  lines.push('*Exported from CrewMeld*')
  lines.push('')
  return lines.join('\n')
}
