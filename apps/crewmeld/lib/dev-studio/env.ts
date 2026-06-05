/**
 * Dev Studio environment-variable validation.
 *
 * Fail-fast: any missing or malformed env is reported at startup
 * (instrumentation.ts) rather than only when the operator clicks
 * "Start dev-studio session" — that way a misconfiguration surfaces before
 * any user-visible workflow tries to use it.
 */
import { z } from 'zod'

const EnvSchema = z.object({
  OPENSANDBOX_SERVER_URL: z.string().url(),
  OPENSANDBOX_API_KEY: z.string().min(1),
  // When set to "1" or "true": webui traffic goes through the OpenSandbox
  // server's reverse-proxy path (/v1/sandboxes/<id>/proxy/<port>/) instead of
  // the raw pod ClusterIP returned by getSandboxEndpoint. Required for local
  // development against a remote k8s deployment where pod CIDR is unreachable
  // from the host. Leave unset / =0 for in-cluster deployments (e.g. k3s prod)
  // so traffic stays on the direct pod path — one fewer hop.
  OPENSANDBOX_USE_PROXY: z
    .string()
    .optional()
    .transform((v) => v === '1' || v === 'true'),
  CREWMELD_SANDBOX_IMAGE: z.string().min(1).default('crewmeld/dev-sandbox:latest'),
  CREWMELD_SANDBOX_TTL_SECONDS: z.coerce.number().int().positive().default(7200),
  // Legacy `CREWMELD_SESSIONS_DIR` was removed in spec 2026-05-28 Task 18 —
  // host paths now derive exclusively from CREWMELD_BFF_VOLUME_ROOT via the
  // paths facade. The env name is still listed in instrumentation.ts's
  // deprecation warnings so misconfigured deployments get a heads-up log.
  // NFS shared volume roots. See spec 2026-05-28-cross-platform-nfs-volume-design.md.
  CREWMELD_BFF_VOLUME_ROOT: z.string().min(1),
  CREWMELD_SANDBOX_VOLUME_ROOT: z.string().min(1),
  // OpenSandbox requires resourceLimits on every CreateSandboxRequest.
  // Format mirrors Kubernetes resource spec (e.g. '500m', '2Gi').
  CREWMELD_SANDBOX_CPU: z.string().min(1).default('1000m'),
  CREWMELD_SANDBOX_MEMORY: z.string().min(1).default('2Gi'),
  // Optional pip index mirror. When set, the sandbox entrypoint writes
  // /root/.pip/pip.conf with this index-url and a matching trusted-host
  // before launching claude-code-webui.
  CREWMELD_PIP_INDEX_URL: z.string().url().optional(),
  // Optional since Sub-spec C (D2/D4): a session may instead pin a model_configs
  // row whose decrypted key is injected by model-resolver.ts. Only required at
  // session-create time when no modelConfigId is supplied (enforced there).
  ANTHROPIC_AUTH_TOKEN: z.string().min(1).optional(),
  ANTHROPIC_BASE_URL: z.string().url().default('https://qianfan.baidubce.com/anthropic/coding'),
  ANTHROPIC_MODEL: z.string().min(1).default('qianfan-code-latest'),
  ANTHROPIC_SMALL_FAST_MODEL: z.string().optional(),
})

export type DevStudioEnv = z.infer<typeof EnvSchema>

let cached: DevStudioEnv | null = null

export function getDevStudioEnv(): DevStudioEnv {
  if (cached) return cached
  const result = EnvSchema.safeParse(process.env)
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')
    throw new Error(`Dev Studio env validation failed:\n${issues}`)
  }
  cached = result.data
  return cached
}

/** Test-only: reset the cached env so tests can mutate process.env */
export function resetCache(): void {
  cached = null
}
