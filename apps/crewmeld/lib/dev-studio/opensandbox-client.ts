/**
 * OpenSandbox REST client — thin facade over the official
 * `@alibaba-group/opensandbox` SDK.
 *
 * Why a facade instead of using the SDK directly:
 *  - Keeps the BFF call sites stable across SDK version bumps
 *  - Localises the URL parsing + "destroy is idempotent on 404" tweak
 *  - Tests can mock the SDK module at the boundary without touching consumers
 *
 * Only the 5 lifecycle methods Dev Studio needs are exposed here.
 * Sub-spec D (file upload) will add execd file/command surfaces via Sandbox.
 */

import {
  ConnectionConfig,
  createDefaultAdapterFactory,
  DEFAULT_EXECD_PORT,
  type ExecdCommands,
  type NetworkPolicy as SdkNetworkPolicy,
  SandboxApiException,
  type Sandboxes,
  type SnapshotInfo,
} from '@alibaba-group/opensandbox'

/**
 * Shape of the object returned by `factory.createExecdStack(...)`. SDK 0.1.x
 * does not export a named type for it, so we derive one structurally from the
 * factory's own return type. `files` is the one we care about beyond
 * `commands` — it backs the directory listing / file read flow used by the
 * dev-studio workspace panel.
 */
type ExecdStack = ReturnType<ReturnType<typeof createDefaultAdapterFactory>['createExecdStack']>
/** SDK adapter for reading/writing files inside a sandbox over execd. */
export type ExecdFiles = ExecdStack['files']

export interface OpenSandboxClientOptions {
  /** e.g. http://localhost:8080 */
  serverUrl: string
  apiKey: string
  /**
   * When true, {@link OpenSandboxClient.getEndpoint} returns a URL pointing at
   * the OpenSandbox server's reverse-proxy path instead of the raw pod
   * endpoint returned by the SDK's `getSandboxEndpoint`. Required when the
   * caller cannot reach pod CIDR directly (e.g. dev workstation against a
   * remote k8s OpenSandbox deployment). Defaults to false so in-cluster
   * deployments keep using the lowest-latency direct pod path.
   *
   * Callers MUST also include {@link OpenSandboxClient.proxyHeaders} when
   * fetching the returned URL — the proxy path requires the API key header.
   */
  useProxy?: boolean
}

/**
 * Host bind-mount volume spec. The SDK accepts a richer Volume union (pvc,
 * ossfs, host); we only need host for Dev Studio.
 */
export interface HostVolume {
  /** DNS-label-safe name unique within the sandbox. */
  name: string
  /** Absolute host path; supports Unix and Windows (e.g. 'D:/ai/...'). */
  hostPath: string
  /** Absolute path inside the container, must start with '/'. */
  mountPath: string
  readOnly?: boolean
}

/**
 * Network egress rule. `target` is an FQDN (FQDN-only is enforced upstream by
 * network-policy-builder for the manifest source; the user-ad-hoc source may
 * also pass IPs which the underlying NetworkPolicy will accept verbatim).
 */
export interface NetworkPolicyRule {
  action: 'allow' | 'deny'
  target: string
}

/**
 * Sandbox-level network policy. `defaultAction='deny'` with an empty `egress`
 * list means the sandbox cannot reach any host. Mirrors the SDK's
 * `NetworkPolicy` shape (see `run_in_sandbox.py` for canonical usage).
 */
export interface NetworkPolicy {
  defaultAction: 'allow' | 'deny'
  egress?: NetworkPolicyRule[]
}

export interface CreateSandboxParams {
  /** OCI image URI. Mutually exclusive with `snapshotId`. */
  image?: string
  /** Restore from a previously created snapshot instead of an image. */
  snapshotId?: string
  /** Entry process argv. Required by OpenSandbox when `image` is provided. */
  entrypoint?: string[]
  /** Resource limits (e.g. { cpu: '1000m', memory: '2Gi' }). Required. */
  resourceLimits: Record<string, string>
  timeoutSeconds?: number
  env?: Record<string, string>
  volumes?: HostVolume[]
  /** Custom metadata for management/filtering (e.g. { 'crewmeld.purpose': 'deploy' }). */
  metadata?: Record<string, string>
  /** Optional egress allow-list policy applied at sandbox creation. */
  networkPolicy?: NetworkPolicy
}

export interface CreateSandboxResult {
  id: string
}

export interface WaitOptions {
  timeoutMs: number
  intervalMs: number
}

/** Terminal sandbox states that we treat as failure (not retryable from Pending) */
const TERMINAL_FAILURE_STATES = new Set(['Failed', 'Stopped', 'Terminating', 'Terminated'])

function sanitizeMetadata(meta: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(meta)) {
    let sanitized = v.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 63)
    sanitized = sanitized.replace(/^[^a-zA-Z0-9]+/, '').replace(/[^a-zA-Z0-9]+$/, '')
    out[k] = sanitized || 'unknown'
  }
  return out
}

interface BuildResult {
  sandboxes: Sandboxes
  /** Protocol to use when constructing endpoint URLs returned by getEndpoint. */
  protocol: 'http' | 'https'
  /** ConnectionConfig retained so exec() can lazily build per-sandbox execd stacks. */
  connectionConfig: ConnectionConfig
  /** Factory retained so exec() can build execd stacks bound to the sandbox endpoint. */
  factory: ReturnType<typeof createDefaultAdapterFactory>
}

/**
 * Builds a `Sandboxes` service from a server URL + API key. Extracted so tests
 * can swap implementations by mocking the SDK module.
 */
function buildSandboxes(serverUrl: string, apiKey: string): BuildResult {
  const u = new URL(serverUrl)
  const protocol = u.protocol.replace(':', '')
  if (protocol !== 'http' && protocol !== 'https') {
    throw new Error(`OpenSandbox serverUrl must be http(s); got ${u.protocol}`)
  }
  const connectionConfig = new ConnectionConfig({
    domain: u.host,
    protocol: protocol as 'http' | 'https',
    apiKey,
  })
  const factory = createDefaultAdapterFactory()
  const sandboxes = factory.createLifecycleStack({
    connectionConfig,
    lifecycleBaseUrl: connectionConfig.getBaseUrl(),
  }).sandboxes
  return { sandboxes, protocol: protocol as 'http' | 'https', connectionConfig, factory }
}

/**
 * Result of executing a shell command inside a sandbox via execd.
 *
 * `exitCode` is normalized to `-1` when the underlying execd reports `null`
 * (typically a still-running background command or an aborted execution) so
 * callers can switch on a plain `number` without a null guard.
 */
export interface ExecResult {
  stdout: string
  stderr: string
  exitCode: number
  durationMs: number
}

export interface ExecArgs {
  sandboxId: string
  /**
   * argv-style command. Tokens are shell-joined and quoted by `joinArgv` so a
   * caller can pass `['bash', '-c', 'echo hi && ls']` without worrying about
   * spaces or single quotes in tail tokens.
   */
  cmd: string[]
  /**
   * Raw bytes to feed on the command's stdin. Implemented as
   * `printf '%s' '<escaped>' | <command>` because the execd `run` API has no
   * native stdin channel in SDK 0.1.x.
   */
  stdin?: string
  /** Default 30 000 ms. Rounded up to whole seconds for execd's `timeoutSeconds`. */
  timeoutMs?: number
}

const NEEDS_SHELL_QUOTE_RE = /[^A-Za-z0-9_\-+.,/:=@%]/

/**
 * Quote a single shell argv token using POSIX single-quote rules.
 *
 * - Tokens that match `^[A-Za-z0-9_\-+.,/:=@%]+$` are emitted verbatim.
 * - Any other token is wrapped in single quotes; literal `'` becomes `'\''`.
 */
function shellQuote(token: string): string {
  if (token.length === 0) return "''"
  if (!NEEDS_SHELL_QUOTE_RE.test(token)) return token
  return `'${token.replace(/'/g, "'\\''")}'`
}

/**
 * Join argv tokens into a single shell-safe command string suitable for
 * `ExecdCommands.run`, which accepts only a string command.
 */
function joinArgv(argv: string[]): string {
  return argv.map(shellQuote).join(' ')
}

export class OpenSandboxClient {
  private readonly sandboxes: Sandboxes
  private readonly protocol: 'http' | 'https'
  private readonly connectionConfig: ConnectionConfig
  private readonly factory: ReturnType<typeof createDefaultAdapterFactory>
  private readonly apiKey: string
  private readonly useProxy: boolean
  /**
   * Cache execd stacks per sandboxId so repeated calls reuse the same
   * adapters. Caching the entire stack (commands + files + health + metrics)
   * — not just `commands` — keeps a single endpoint resolution behind every
   * surface the BFF touches.
   */
  private readonly execdCache = new Map<string, ExecdStack>()

  constructor(opts: OpenSandboxClientOptions) {
    const built = buildSandboxes(opts.serverUrl, opts.apiKey)
    this.sandboxes = built.sandboxes
    this.protocol = built.protocol
    this.connectionConfig = built.connectionConfig
    this.factory = built.factory
    this.apiKey = opts.apiKey
    this.useProxy = opts.useProxy ?? false
  }

  /**
   * HTTP headers the caller MUST include when fetching the URL returned by
   * {@link getEndpoint} in proxy mode. Returns `{}` when proxy mode is off,
   * so call sites can unconditionally spread `client.proxyHeaders()` into
   * their fetch options without branching.
   */
  proxyHeaders(): Record<string, string> {
    return this.useProxy ? { 'OPEN-SANDBOX-API-KEY': this.apiKey } : {}
  }

  isProxyMode(): boolean {
    return this.useProxy
  }

  async createSandbox(params: CreateSandboxParams): Promise<CreateSandboxResult> {
    const res = await this.sandboxes.createSandbox({
      ...(params.snapshotId
        ? { snapshotId: params.snapshotId }
        : params.image ? { image: { uri: params.image } } : {}),
      entrypoint: params.entrypoint,
      resourceLimits: params.resourceLimits,
      timeout: params.timeoutSeconds,
      env: params.env,
      volumes: params.volumes?.map((v) => ({
        name: v.name,
        host: { path: v.hostPath },
        mountPath: v.mountPath,
        readOnly: v.readOnly ?? false,
      })),
      ...(params.networkPolicy
        ? {
            // The SDK's NetworkRule extends Record<string, unknown>, which our
            // narrower NetworkPolicyRule (action + target only) does not
            // structurally satisfy. The runtime shapes are identical, so a
            // single cast through the SDK alias keeps the SDK call typed
            // without leaking the index signature into our public types.
            networkPolicy: {
              defaultAction: params.networkPolicy.defaultAction,
              egress: params.networkPolicy.egress,
            } as unknown as SdkNetworkPolicy,
          }
        : {}),
      ...(params.metadata ? { metadata: sanitizeMetadata(params.metadata) } : {}),
    })
    return { id: res.id as string }
  }

  async getSandbox(id: string): Promise<{ id: string; state: string }> {
    const info = await this.sandboxes.getSandbox(id)
    return { id: info.id as string, state: info.status?.state ?? 'Unknown' }
  }

  async waitUntilRunning(id: string, opts: WaitOptions): Promise<void> {
    const deadline = Date.now() + opts.timeoutMs
    while (Date.now() < deadline) {
      const sb = await this.getSandbox(id)
      if (sb.state === 'Running') return
      if (TERMINAL_FAILURE_STATES.has(sb.state)) {
        throw new Error(`Sandbox ${id} entered terminal state: ${sb.state}`)
      }
      await new Promise((r) => setTimeout(r, opts.intervalMs))
    }
    throw new Error(`Sandbox ${id} timed out waiting for Running state`)
  }

  async getEndpoint(id: string, port: number): Promise<string> {
    if (this.useProxy) {
      // Route through the server's reverse-proxy path so callers outside the
      // k8s pod network (e.g. dev workstation against a remote cluster) can
      // reach webui. The trailing slash matters — proxy expects path-prefix
      // semantics, and `${webuiUrl}/api/chat` then resolves correctly.
      const base = this.connectionConfig.getBaseUrl().replace(/\/$/, '')
      return `${base}/sandboxes/${encodeURIComponent(id)}/proxy/${port}`
    }
    const ep = await this.sandboxes.getSandboxEndpoint(id, port)
    if (!ep.endpoint) throw new Error('OpenSandbox getSandboxEndpoint returned no endpoint')
    // SDK returns endpoint as bare host:port (e.g. "localhost:34567") — prepend
    // the scheme so callers can use it as a base URL directly. If the endpoint
    // already contains a scheme (some configs return absolute URLs), pass through.
    if (/^https?:\/\//.test(ep.endpoint)) return ep.endpoint
    return `${this.protocol}://${ep.endpoint}`
  }

  /**
   * Destroys a sandbox. Idempotent: a 404 response (already gone) is swallowed.
   *
   * Also evicts any cached execd stack for this sandbox so a future sandbox
   * reusing the same id (or a subsequent test fixture) does not pick up the
   * now-stale `execdBaseUrl` bound at first {@link exec} call.
   */
  async destroy(id: string): Promise<void> {
    try {
      await this.sandboxes.deleteSandbox(id)
    } catch (e) {
      if (e instanceof SandboxApiException && e.statusCode === 404) {
        this.execdCache.delete(id)
        return
      }
      throw e
    }
    this.execdCache.delete(id)
  }

  /**
   * Renews a sandbox's expiration by `extendSeconds` from now. The SDK uses
   * an absolute `expiresAt` ISO timestamp under the hood; we compute it here
   * to match our call-site API which thinks in deltas.
   */
  async renew(id: string, extendSeconds: number): Promise<void> {
    const expiresAt = new Date(Date.now() + extendSeconds * 1000).toISOString()
    await this.sandboxes.renewSandboxExpiration(id, { expiresAt })
  }

  async pauseSandbox(id: string): Promise<void> {
    await this.sandboxes.pauseSandbox(id)
  }

  async createSnapshot(sandboxId: string, name?: string): Promise<SnapshotInfo> {
    return this.sandboxes.createSnapshot(sandboxId, name ? { name } : undefined)
  }

  async waitUntilSnapshotReady(snapshotId: string, opts: WaitOptions): Promise<void> {
    const deadline = Date.now() + opts.timeoutMs
    while (Date.now() < deadline) {
      const snap = await this.sandboxes.getSnapshot(snapshotId)
      if (snap.status.state === 'Ready') return
      if (snap.status.state === 'Failed') {
        throw new Error(`Snapshot ${snapshotId} failed: ${snap.status.reason ?? snap.status.message ?? 'unknown'}`)
      }
      await new Promise((r) => setTimeout(r, opts.intervalMs))
    }
    throw new Error(`Snapshot ${snapshotId} timed out waiting for Ready state`)
  }

  async deleteSnapshot(snapshotId: string): Promise<void> {
    try {
      await this.sandboxes.deleteSnapshot(snapshotId)
    } catch (e) {
      if (e instanceof SandboxApiException && e.statusCode === 404) return
      throw e
    }
  }

  /**
   * Pick the execd base URL + auth headers for a sandbox.
   *
   * - **proxy mode** (`useProxy=true`): wraps the server's reverse-proxy path
   *   `/v1/sandboxes/<id>/proxy/44772` so dev workstations outside the k8s
   *   pod network can reach execd. Auth flows via `OPEN-SANDBOX-API-KEY`.
   * - **direct mode**: pulls the pod ClusterIP from the SDK's
   *   `getSandboxEndpoint` (lowest latency; valid only when the caller lives
   *   inside the cluster).
   */
  private async resolveExecdEndpoint(
    sandboxId: string
  ): Promise<{ baseUrl: string; headers: Record<string, string> | undefined }> {
    if (this.useProxy) {
      const base = this.connectionConfig.getBaseUrl().replace(/\/$/, '')
      return {
        baseUrl: `${base}/sandboxes/${encodeURIComponent(sandboxId)}/proxy/${DEFAULT_EXECD_PORT}`,
        headers: { 'OPEN-SANDBOX-API-KEY': this.apiKey },
      }
    }
    const ep = await this.sandboxes.getSandboxEndpoint(sandboxId, DEFAULT_EXECD_PORT)
    if (!ep.endpoint) {
      throw new Error(
        `OpenSandbox getSandboxEndpoint returned no endpoint for sandbox ${sandboxId}`
      )
    }
    const baseUrl = /^https?:\/\//.test(ep.endpoint)
      ? ep.endpoint
      : `${this.protocol}://${ep.endpoint}`
    return { baseUrl, headers: ep.headers }
  }

  /**
   * Resolve (and memoize) the execd stack — commands + files + health +
   * metrics — for a sandbox. All surfaces share the same endpoint resolution
   * and credentials so a proxy-mode flip only needs to happen once per
   * sandbox lifetime.
   */
  private async getStack(sandboxId: string): Promise<ExecdStack> {
    const cached = this.execdCache.get(sandboxId)
    if (cached) return cached
    const { baseUrl, headers } = await this.resolveExecdEndpoint(sandboxId)
    const stack = this.factory.createExecdStack({
      connectionConfig: this.connectionConfig,
      execdBaseUrl: baseUrl,
      endpointHeaders: headers,
    })
    this.execdCache.set(sandboxId, stack)
    return stack
  }

  private async getCommands(sandboxId: string): Promise<ExecdCommands> {
    return (await this.getStack(sandboxId)).commands
  }

  /**
   * Expose the SDK's `files` adapter for a sandbox — directory listing
   * (`search`), reads (`readFile`, `readBytesStream`), writes
   * (`writeFiles`, `replaceContents`), and metadata (`getFileInfo`).
   * Backs the dev-studio file tree + preview routes in proxy mode where the
   * legacy host-fs implementation can never find the sandbox files.
   */
  async getFiles(sandboxId: string): Promise<ExecdFiles> {
    return (await this.getStack(sandboxId)).files
  }

  /**
   * Execute a shell command inside a sandbox via execd and return aggregated
   * stdout/stderr plus the exit code.
   *
   * Implementation notes:
   *  - argv is joined via {@link joinArgv} (single-quote safe).
   *  - `stdin`, if supplied, is delivered by piping `printf '%s' '<escaped>' |`
   *    in front of the assembled command — execd's `run` has no native stdin.
   *  - `timeoutMs` is rounded up to whole seconds for execd's `timeoutSeconds`.
   *  - A `null` exitCode (still-running / aborted) is normalized to `-1`.
   */
  async exec(args: ExecArgs): Promise<ExecResult> {
    const timeoutMs = args.timeoutMs ?? 30_000
    const baseCommand = joinArgv(args.cmd)
    const command =
      args.stdin === undefined
        ? baseCommand
        : `printf '%s' ${shellQuote(args.stdin)} | ${baseCommand}`

    const commands = await this.getCommands(args.sandboxId)
    const start = Date.now()
    const execution = await commands.run(command, {
      timeoutSeconds: Math.ceil(timeoutMs / 1000),
    })
    const durationMs = Date.now() - start

    const stdout = (execution.logs?.stdout ?? []).map((m) => m.text).join('')
    const stderr = (execution.logs?.stderr ?? []).map((m) => m.text).join('')
    const rawExit = execution.exitCode
    const exitCode = typeof rawExit === 'number' ? rawExit : -1

    return { stdout, stderr, exitCode, durationMs }
  }
}

/**
 * Lazy singleton used by the module-level {@link exec} wrapper. Constructed on
 * first call from `OPENSANDBOX_SERVER_URL` / `OPENSANDBOX_API_KEY` env vars so
 * callers (e.g. test-runner) can `import * as openSandbox` and just invoke
 * `openSandbox.exec(args)` without plumbing env through every layer.
 */
let defaultClient: OpenSandboxClient | null = null

function getDefaultClient(): OpenSandboxClient {
  if (defaultClient) return defaultClient
  const serverUrl = process.env.OPENSANDBOX_SERVER_URL
  const apiKey = process.env.OPENSANDBOX_API_KEY
  if (!serverUrl || !apiKey) {
    throw new Error(
      'opensandbox-client.exec(): OPENSANDBOX_SERVER_URL and OPENSANDBOX_API_KEY env vars are required'
    )
  }
  defaultClient = new OpenSandboxClient({
    serverUrl,
    apiKey,
    useProxy: process.env.OPENSANDBOX_USE_PROXY === 'true' || process.env.OPENSANDBOX_USE_PROXY === '1',
  })
  return defaultClient
}

/**
 * Public accessor for the lazy singleton {@link OpenSandboxClient} used by
 * full-lifecycle orchestrators (e.g. sandbox-loader). Reads the same env vars
 * as the {@link exec} wrapper so a single config drives every code path.
 */
export function getOpenSandboxClient(): OpenSandboxClient {
  return getDefaultClient()
}

/** Test-only hook to reset the cached default client. */
export function resetDefaultClientForTests(): void {
  defaultClient = null
}

/**
 * Module-level convenience wrapper for {@link OpenSandboxClient.exec}.
 *
 * Constructs a singleton client from `OPENSANDBOX_*` env vars on first call so
 * test-runner / BFF code can stay free of client lifecycle plumbing.
 *
 * Returns a rejected promise (rather than throwing synchronously) for misconfig
 * so call sites can rely on a single error-handling path.
 */
export async function exec(args: ExecArgs): Promise<ExecResult> {
  return getDefaultClient().exec(args)
}
