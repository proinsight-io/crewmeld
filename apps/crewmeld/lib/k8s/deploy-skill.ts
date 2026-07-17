import fs from 'node:fs/promises'
import path from 'node:path'
import { createLogger } from '@crewmeld/logger'
import { readManifestFromTool } from '@/lib/dev-studio/manifest-reader'
import { applyManifestDefaults } from '@/lib/dev-studio/package-defaults'
import { paths } from '@/lib/dev-studio/paths'
import type { SkillPackage } from '@/app/(employee)/skills/types'

/**
 * Tool deployment via OpenSandbox (dev-studio tools).
 *
 * The legacy K8s inline-code deployment path (Deployment/Service + rclone/MinIO
 * sidecar + warm pool) has been removed — every tool now runs either in an
 * OpenSandbox sandbox (source === 'dev-studio', NFS `/root/io`) or in-process
 * (kind === 'api'). `deploySkill` only handles dev-studio tools; anything else
 * throws.
 */

const logger = createLogger('K8sDeploySkill')

const K8S_API_SERVER = process.env.K8S_API_SERVER ?? ''
const K8S_API_TOKEN = process.env.K8S_API_TOKEN ?? ''

// ---------------------------------------------------------------------------
// Public config checks
// ---------------------------------------------------------------------------

export function isK8sConfigured(): boolean {
  return Boolean(K8S_API_SERVER && K8S_API_TOKEN)
}

/**
 * Whether K8S calls should be mocked. Enables local development without a
 * real cluster — every entry point returns a fake-but-shaped response.
 */
export function isK8sMockMode(): boolean {
  return process.env.K8S_MOCK === 'true'
}

/** Stable string hash used to derive deterministic mock node ports. */
function hashString(input: string): number {
  let hash = 0
  for (let i = 0; i < input.length; i++) {
    hash = (hash << 5) - hash + input.charCodeAt(i)
    hash |= 0
  }
  return hash
}

// ---------------------------------------------------------------------------
// Dev-studio tool deployment via OpenSandbox (source === 'dev-studio')
// ---------------------------------------------------------------------------
//
// After the NFS migration (spec 2026-05-28 §11.1/§11.2) tool code lives at
// `paths.toolCode.forBff(toolId)` and shared Python deps live at
// `paths.sharedLibs.forBff()`. Deployment no longer downloads zip bytes,
// builds local-dev workarounds, or snapshots a template sandbox — it just
// validates the on-disk artifacts and (for service kind) starts a persistent
// sandbox with NFS volumes mounted in.

/** Long-lived sandbox TTL: 30 days. Deployed services stay up until explicit undeploy. */
/** undefined = manual cleanup mode (no TTL, container lives until explicit destroy) */
const DEPLOY_SANDBOX_TIMEOUT_SECONDS: number | undefined = undefined

/**
 * Poll a port inside a sandbox via Python socket probe until it responds or deadline passes.
 */
async function waitForPort(
  client: {
    exec: (args: {
      sandboxId: string
      cmd: string[]
      timeoutMs: number
    }) => Promise<{ exitCode: number }>
  },
  sandboxId: string,
  port: number,
  timeoutMs: number
): Promise<boolean> {
  const probeCmd = `python3 -c "import socket; s=socket.socket(); s.settimeout(1); s.connect(('localhost',${port})); s.close()"`
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await client.exec({
        sandboxId,
        cmd: ['bash', '-c', probeCmd],
        timeoutMs: 5_000,
      })
      if (res.exitCode === 0) return true
    } catch {
      // probe failed -- keep retrying
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

/** Result for service-type dev-studio tool (long-lived container with HTTP endpoint). */
interface CmtoolServiceResult {
  kind: 'service'
  endpoint: string
  nodePort: number
  sandboxId: string
  useProxy: boolean
}

/**
 * Result for script-type dev-studio tool.
 *
 * No persistent sandbox: invoke creates an ephemeral container per call,
 * mounting tool code + shared site-packages from NFS. The invoke route reads
 * the manifest itself from NFS, so deploy returns no snapshot payload.
 */
interface CmtoolScriptResult {
  kind: 'script'
}

type CmtoolDeployResult = CmtoolServiceResult | CmtoolScriptResult

/**
 * Deploy a dev-studio (source === 'dev-studio') tool via OpenSandbox.
 *
 * - kind=service: long-lived sandbox with NFS volumes mounted; `init.sh` runs
 *   once (pip install is a no-op because the shared-libs prewarmer has
 *   already populated `paths.sharedLibs`), then `start.sh` is launched via
 *   nohup and we wait for the configured port.
 * - kind=script:  no container created at deploy time. Validate that
 *   `start.sh` exists on NFS and that the shared-libs cache contains the
 *   manifest's declared libraries. Invoke creates an ephemeral container per
 *   call (see `app/api/tools/[instanceId]/invoke/route.ts`).
 */
async function deployCmtoolSkill(skill: SkillPackage): Promise<CmtoolDeployResult> {
  // Code on NFS lives under the tool TEMPLATE id, not the instance id. When
  // deploying an instance, the route passes `templateId` separately; fall back
  // to `id` for backwards compat with callers that haven't been migrated yet.
  const toolId = skill.templateId ?? skill.id
  const codeDir = paths.toolCode.forBff(toolId)
  try {
    await fs.access(path.join(codeDir, 'start.sh'))
  } catch {
    throw new Error(
      `Tool code missing or incomplete on NFS for tool ${toolId}: ` +
        `${path.join(codeDir, 'start.sh')} not found. Re-adopt (dev-studio tool) or ` +
        `re-import the .cmtool package (imported tool) to sync the workspace.`
    )
  }

  const manifest = await readManifestFromTool(toolId)
  if (!manifest) {
    throw new Error(
      `Manifest missing on NFS for tool ${toolId} ` +
        `(expected at ${path.join(codeDir, '.crewmeld-studio/manifest.json')}).`
    )
  }
  const withDefaults = applyManifestDefaults(manifest)

  if (isK8sMockMode()) {
    const mockPort = 30000 + (Math.abs(hashString(skill.id)) % 1000)
    logger.info(`K8S_MOCK: returning fake endpoint for dev-studio skill ${skill.id}`)
    if (withDefaults.kind === 'script') {
      return { kind: 'script' }
    }
    return {
      kind: 'service',
      endpoint: `http://mock-k8s:${mockPort}`,
      nodePort: mockPort,
      sandboxId: 'mock-sandbox',
      useProxy: false,
    }
  }

  const { getOpenSandboxClient } = await import('@/lib/dev-studio/opensandbox-client')
  const { DEFAULT_IMAGE } = await import('@/lib/dev-studio/package-defaults')
  const { buildToolNetworkPolicy } = await import('@/lib/dev-studio/network-policy-builder')
  const { getSandboxSettings } = await import('@/lib/sandbox/settings')

  const image = withDefaults.image ?? DEFAULT_IMAGE
  const resourceLimits = withDefaults.resources?.limits ?? {
    cpu: '500m',
    memory: '512Mi',
    'ephemeral-storage': '1Gi',
  }

  // Script-type: nothing to start at deploy time. Confirm shared-libs is
  // prewarmed so invoke does not have to pay pip install cost.
  if (withDefaults.kind === 'script') {
    const requiredLibs = manifest.dependencies.libraries
    if (requiredLibs.length > 0) {
      const sharedLibsDir = paths.sharedLibs.forBff()
      try {
        const entries = await fs.readdir(sharedLibsDir)
        if (entries.length === 0) {
          throw new Error(
            `shared-libs site-packages is empty at ${sharedLibsDir}; ` +
              `prewarmer must run before deploying script-type tool ${skill.id}.`
          )
        }
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e)
        throw new Error(
          `Cannot read shared-libs site-packages at ${sharedLibsDir}: ${detail}. ` +
            `Run dependency prewarmer for skill ${skill.id}.`
        )
      }
    }
    logger.info('Script-type dev-studio tool deployed (NFS volumes, no persistent sandbox)', {
      skillId: skill.id,
      libraries: requiredLibs.length,
    })
    return { kind: 'script' }
  }

  // Service-type: build env, egress, then create persistent sandbox with NFS volumes.
  const servicePort = withDefaults.service?.port ?? 3000
  const client = getOpenSandboxClient()

  const envVars: Record<string, string> = {}
  if (manifest.env?.properties) {
    for (const [k, prop] of Object.entries(manifest.env.properties)) {
      if (prop.default !== undefined && prop.default !== null) {
        envVars[k] = String(prop.default)
      }
    }
  }
  if (skill.envVars) {
    for (const e of skill.envVars) {
      envVars[e.name] = String(e.value ?? '')
    }
  }

  const pipIndexUrl = process.env.CREWMELD_SANDBOX_PIP_INDEX ?? ''
  const sandboxEnv: Record<string, string> = {
    ...envVars,
    // Make the prewarmed shared site-packages visible to `python` and `init.sh`
    // so pip install becomes a no-op even when manifest authors leave it in.
    PYTHONPATH: '/shared/site-packages',
    // Console_scripts from `pip install --target` (uvicorn, gunicorn, ...)
    // live in `/shared/site-packages/bin`. Without this prefix start.sh's
    // `exec uvicorn ...` dies with "uvicorn: not found" — same fix as the
    // run-test sandbox in sandbox-loader.ts.
    PATH: '/shared/site-packages/bin:/usr/local/bin:/usr/bin:/bin',
    ...(pipIndexUrl ? { PIP_INDEX_URL: pipIndexUrl } : {}),
  }

  // Network policy follows the admin global egress mode (Model A): unrestricted
  // → reach anything; allowlist → deny-default with manifest domains ∪ admin
  // global allow-lists ∪ pypi mirrors (kept for the occasional manifest dep the
  // prewarmer could not cache) ∪ CREWMELD_SANDBOX_SYSTEM_EGRESS.
  const pypiDomains = [
    'pypi.org',
    'files.pythonhosted.org',
    'pypi.tuna.tsinghua.edu.cn',
    'mirrors.aliyun.com',
  ]
  const sandboxSettings = await getSandboxSettings()
  const deployNetworkPolicy = buildToolNetworkPolicy(
    sandboxSettings.egressMode,
    manifest.dependencies.domains,
    {
      extraDomains: pypiDomains,
      globalDomains: sandboxSettings.allowedDomains,
      globalIps: sandboxSettings.allowedIps,
      toolIps: manifest.dependencies.ips,
    }
  )

  const volumes = [
    {
      name: 'shared-libs',
      hostPath: paths.sharedLibs.forSandbox(),
      mountPath: '/shared/site-packages',
      readOnly: true,
    },
    {
      name: 'tool-code',
      hostPath: paths.toolCode.forSandbox(toolId),
      mountPath: '/root/workspace',
      readOnly: false,
    },
    // Unified file IO contract: long-lived service pod mounts the sop-files
    // ROOT and tool code joins `_sopExecutionId` from each request body to
    // navigate to the per-SOP subdir at `/root/io/<sopExecId>/<filename>`.
    // The intent-router (lib/sop/llm-tool-executor.ts) injects the id; the
    // BFF mkdirs `<volume>/sop-files/<Y>/<M>/<D>/<sopExecId>/` at SOP start
    // and seeds conversation uploads into it. Same dir is served back to
    // the operator via /api/employee/tool-execution/<sopExecId>/files/<name>.
    {
      name: 'sop-files',
      hostPath: paths.sopFiles.forSandbox(),
      mountPath: '/root/io',
      readOnly: false,
    },
  ]

  const createParams = {
    image,
    entrypoint: ['sleep', 'infinity'],
    resourceLimits,
    timeoutSeconds: DEPLOY_SANDBOX_TIMEOUT_SECONDS,
    env: sandboxEnv,
    volumes,
    networkPolicy: deployNetworkPolicy,
    metadata: {
      'crewmeld.purpose': 'deploy',
      'crewmeld.skill-id': skill.id,
      'crewmeld.skill-name': skill.name,
    },
  }
  logger.info('Creating deploy sandbox for dev-studio service tool', {
    skillId: skill.id,
    image,
    servicePort,
  })

  let sandbox: { id: string }
  try {
    sandbox = await client.createSandbox(createParams)
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    const stack = e instanceof Error ? e.stack : undefined
    logger.error('createSandbox failed for dev-studio deploy', { skillId: skill.id, detail, stack })
    throw new Error(`Create sandbox failed: ${detail}`)
  }

  await client.waitUntilRunning(sandbox.id, { timeoutMs: 60_000, intervalMs: 500 })

  // Run init.sh only. Dependencies are NOT pip-installed here: declared libs
  // are prewarmed into the shared site-packages volume (mounted read-only at
  // /shared/site-packages, exposed via PYTHONPATH above). A pip install here is
  // redundant AND fails outright in the no-DNS runtime sandbox — pip still
  // contacts the index to resolve requirements even when the packages are
  // importable via PYTHONPATH (it tracks its own site-packages metadata, not
  // arbitrary PYTHONPATH dirs). init.sh handles only non-pip one-time setup.
  const initRes = await client.exec({
    sandboxId: sandbox.id,
    cmd: ['bash', '-c', 'set -e; cd /root/workspace; [ -f init.sh ] && bash init.sh; true'],
    timeoutMs: 300_000,
  })
  if (initRes.exitCode !== 0) {
    await client.destroy(sandbox.id).catch(() => {})
    throw new Error(`init failed (exit ${initRes.exitCode}): ${initRes.stderr || initRes.stdout}`)
  }

  // Service-type: start the long-running HTTP service
  await client.exec({
    sandboxId: sandbox.id,
    cmd: [
      'bash',
      '-c',
      'cd /root/workspace && nohup bash start.sh > /tmp/dev-studio-service.log 2>&1 &',
    ],
    timeoutMs: 5_000,
  })

  const portReady = await waitForPort(client, sandbox.id, servicePort, 30_000)
  if (!portReady) {
    let logTail = ''
    try {
      const tailRes = await client.exec({
        sandboxId: sandbox.id,
        cmd: ['tail', '-200', '/tmp/dev-studio-service.log'],
        timeoutMs: 5_000,
      })
      logTail = tailRes.stdout
    } catch {
      /* non-fatal */
    }
    await client.destroy(sandbox.id).catch(() => {})
    throw new Error(`Service did not start on port ${servicePort} within 30s.\n${logTail}`)
  }

  const baseEndpoint = await client.getEndpoint(sandbox.id, servicePort)
  const servicePath = withDefaults.service?.path ?? '/'
  const endpoint = `${baseEndpoint.replace(/\/$/, '')}${servicePath}`

  logger.info(`Skill ${skill.name} deployed via OpenSandbox: ${endpoint}`, {
    sandboxId: sandbox.id,
    servicePort,
    servicePath,
  })

  return {
    kind: 'service',
    endpoint,
    nodePort: servicePort,
    sandboxId: sandbox.id,
    useProxy: client.isProxyMode(),
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Unified deploy result — callers check `deployType` to branch. */
export type DeploySkillResult =
  | {
      deployType: 'opensandbox'
      endpoint: string
      nodePort: number
      sandboxId: string
      useProxy: boolean
    }
  | { deployType: 'opensandbox-script' }

/** Deploy a dev-studio tool via OpenSandbox. Non-dev-studio tools are rejected. */
export async function deploySkill(skill: SkillPackage): Promise<DeploySkillResult> {
  if (skill.source !== 'dev-studio') {
    throw new Error(
      'Inline-code K8s tool deployment has been removed; only dev-studio (OpenSandbox) tools can be deployed.'
    )
  }
  const r = await deployCmtoolSkill(skill)
  if (r.kind === 'script') {
    return { deployType: 'opensandbox-script' }
  }
  return {
    deployType: 'opensandbox',
    endpoint: r.endpoint,
    nodePort: r.nodePort,
    sandboxId: r.sandboxId,
    useProxy: r.useProxy,
  }
}

/**
 * Undeploy hook retained for residual callers.
 *
 * Inline-code K8s tools no longer exist, and dev-studio service sandboxes are
 * destroyed directly by the undeploy route via the OpenSandbox client, so there
 * is nothing to tear down here — this is a no-op.
 */
export async function undeploySkill(skillId: string): Promise<void> {
  logger.info('undeploySkill no-op (K8s inline path removed)', { skillId })
}

/**
 * Deploy readiness.
 *
 * Dev-studio deploys are synchronous — `deploySkill` resolves only once the
 * service port is live (or throws) — so there is no asynchronous readiness to
 * poll. Always reports ready.
 */
export async function getDeployStatus(_skillId: string): Promise<{
  ready: boolean
  replicas: number
  readyReplicas: number
}> {
  return { ready: true, replicas: 1, readyReplicas: 1 }
}
