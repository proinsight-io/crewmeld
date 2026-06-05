/**
 * Adopt-time pip dependency installer.
 *
 * Reads manifest.dependencies.libraries and starts a short-lived builder
 * sandbox to `pip install -r` them into the shared NFS site-packages volume.
 * No per-package scan and no conflict detection: pip itself skips
 * already-satisfied packages ("Requirement already satisfied"). The builder
 * runs with defaultAction:'allow' egress — it is transient infra doing pip,
 * not a runtime sandbox running untrusted tool code.
 *
 * Refs spec 2026-05-29-builder-always-pip-install-design.md.
 */
import { paths } from './paths'
import { getOpenSandboxClient } from './opensandbox-client'

/** Default OCI image used for the builder regardless of manifest.image. */
const DEFAULT_IMAGE = 'python:3.12-slim'

/** Builder sandbox lifetime ceiling (10 min) — enough for large wheel pulls. */
const BUILDER_TIMEOUT_SECONDS = 600

/**
 * Structured error returned by adopt-time prewarm operations.
 *
 * @param code - Stable identifier for the failure class.
 * @param detail - Human-readable detail (may include pip stderr tail).
 * @param retryable - Whether the caller can safely retry.
 */
export class AdoptError extends Error {
  constructor(
    public code: string,
    public detail: string,
    public retryable: boolean,
  ) {
    super(`AdoptError[${code}]: ${detail}`)
    this.name = 'AdoptError'
  }
}

/**
 * Minimal manifest shape consumed by the prewarmer. Kept local so adopt-time
 * callers can pass arbitrary JSON objects without full Zod re-validation.
 */
export interface ManifestLike {
  image?: string
  dependencies?: {
    libraries?: string[]
    domains?: string[]
  }
}

/**
 * Install manifest.dependencies.libraries into the shared NFS site-packages
 * volume via a short-lived builder sandbox.
 *
 * Flow:
 *  1. Empty/missing libraries → return immediately.
 *  2. Start builder (defaultAction:'allow', shared-libs RW at /shared/site-packages).
 *  3. Write /tmp/req.txt with every library; run
 *     `pip install --target /shared/site-packages -r /tmp/req.txt`.
 *  4. Non-zero exit → throw {@link AdoptError} code `dependency-install-failed`.
 *  5. Always destroy the builder.
 *
 * @param toolId - Tool identifier, used only for log/metadata correlation.
 * @param manifest - Manifest-like object with optional `image` and libraries.
 */
export async function prewarmDependencies(
  toolId: string,
  manifest: ManifestLike,
): Promise<void> {
  const libraries = manifest.dependencies?.libraries ?? []
  if (libraries.length === 0) return

  const client = getOpenSandboxClient()

  const { id: builderId } = await client.createSandbox({
    image: DEFAULT_IMAGE,
    entrypoint: ['sleep', '600'],
    resourceLimits: { cpu: '500m', memory: '512Mi', 'ephemeral-storage': '2Gi' },
    timeoutSeconds: BUILDER_TIMEOUT_SECONDS,
    env: {
      PIP_INDEX_URL:
        process.env.CREWMELD_SANDBOX_PIP_INDEX ?? 'https://pypi.tuna.tsinghua.edu.cn/simple',
    },
    volumes: [
      {
        name: 'shared-libs',
        hostPath: paths.sharedLibs.forSandbox(),
        mountPath: '/shared/site-packages',
        readOnly: false,
      },
    ],
    networkPolicy: { defaultAction: 'allow' },
    metadata: { 'crewmeld.purpose': 'prewarm', 'crewmeld.tool': toolId },
  })

  try {
    await client.waitUntilRunning(builderId, { timeoutMs: 60_000, intervalMs: 500 })

    const files = await client.getFiles(builderId)
    const reqContent = `${libraries.join('\n')}\n`
    await files.writeFiles([{ path: '/tmp/req.txt', data: reqContent }])

    const result = await client.exec({
      sandboxId: builderId,
      cmd: [
        'pip',
        'install',
        '--target',
        '/shared/site-packages',
        '-r',
        '/tmp/req.txt',
        '--no-input',
        '--quiet',
      ],
      timeoutMs: 300_000,
    })

    if (result.exitCode !== 0) {
      throw new AdoptError(
        'dependency-install-failed',
        `pip install failed (exit ${result.exitCode}):\n${(result.stderr || result.stdout).slice(-2000)}`,
        true,
      )
    }
  } finally {
    await client.destroy(builderId).catch(() => {})
  }
}
