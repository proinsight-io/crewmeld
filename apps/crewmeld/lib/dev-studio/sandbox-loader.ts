/**
 * Orchestrates the fresh-sandbox test run flow:
 *  1. sync           - workspace -> tools-workspace/<toolId>/code via NFS atomic copy
 *  2. cache-libs     - check libs cache, build via builder sandbox if missing
 *  3. create-sandbox - opensandbox create with mounts + networkPolicy + env
 *  4. init           - bash /root/workspace/init.sh
 *  5. start          - kind=service: nohup start.sh + waitForPort
 *  6. invoke         - kind=service: HTTP fetch; kind=script: stdin exec
 *  7. result         - validate against output schema, emit result event
 *  8. cleanup        - destroy on success, retain 5min on failure
 *
 * The caller drives consumption via the `emit` callback so the route handler
 * can forward each event as an SSE frame without buffering.
 */

import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { createLogger } from '@crewmeld/logger'
import { resolveConnectionEnvVars } from '@/lib/connectors/resolve-conn-env'
import { getRedisClient } from '@/lib/core/config/redis'
import { syncWorkspaceToCode } from './code-sync'
import { type ManifestT, readManifestFromTool } from './manifest-reader'
import { getSandboxSettings } from '@/lib/sandbox/settings'
import { buildToolNetworkPolicy, validateManifestDomains } from './network-policy-builder'
import { getOpenSandboxClient, type OpenSandboxClient } from './opensandbox-client'
import { applyManifestDefaults, DEFAULT_IMAGE } from './package-defaults'
import { paths } from './paths'
import { seedSopFilesFromSession } from './io-sync'
import { sessionStore } from './session-store'

const logger = createLogger('SandboxLoader')

/** Builder sandbox lifetime ceiling (10 min) -- enough for large wheel pulls. */
const BUILDER_TIMEOUT_SECONDS = 600

/** Test sandbox lifetime ceiling on the SDK side. The 5-minute retain-on-fail
 *  logic runs separately via setTimeout; the SDK timeout is a hard upper bound. */
const TEST_SANDBOX_TIMEOUT_SECONDS = 30 * 60

/** Retain-on-failure window in seconds. */
const RETAIN_SECONDS = 300

/** Redis key prefix for retained sandbox bookkeeping. */
const RETAIN_KEY_PREFIX = 'dev-studio:retain:'

/**
 * Walk `manifest.env.properties` and return a `{KEY: stringDefault}` map.
 * Properties without a `default` are skipped -- the operator is expected to
 * supply them at run-test time.
 */
function defaultEnv(manifest: ManifestT): Record<string, string> {
  const out: Record<string, string> = {}
  const props = manifest.env?.properties
  if (!props) return out
  for (const [k, prop] of Object.entries(props)) {
    if (prop.default !== undefined && prop.default !== null) {
      out[k] = String(prop.default)
    }
  }
  return out
}

/**
 * Coerce a `Record<string, unknown>` of user-supplied env values into the
 * `Record<string, string>` shape OpenSandbox expects. Null/undefined values
 * are dropped so the operator can leave a field blank to fall back to the
 * manifest default.
 */
function stringifyValues(obj: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (v !== null && v !== undefined) out[k] = String(v)
  }
  return out
}

/**
 * Return the last `n` lines of a string, capped at 200 by default. Used to
 * tail service logs on failure for the error message.
 */
function tail200(s: string, n = 200): string {
  const lines = s.split('\n')
  return lines.slice(-n).join('\n')
}

/**
 * Whether a Content-Type header indicates a binary payload that must not be
 * forwarded as the response body for tools that declare a file-typed output.
 *
 * Match families:
 *   - `image/*`               PNG, JPEG, SVG, ...
 *   - `application/pdf`       PDF specifically (covered by manifest output.type=pdf)
 *   - `application/octet-stream`  generic binary; if the tool returns this with
 *                                 a file-output manifest it's still a contract
 *                                 violation (BFF can't tell it's a file)
 *   - `video/*` / `audio/*`   media binaries
 *
 * `application/json` (incl. `application/json; charset=utf-8`) is NOT binary —
 * that's the only acceptable response for file-output service tools. Plain
 * `text/*` is also accepted (some tools return progress text + write outputs
 * to /root/io); the check is intentionally conservative — only formats that
 * unambiguously indicate "the body IS the artefact" trip it.
 */
export function isBinaryContentType(contentType: string): boolean {
  const ct = contentType.toLowerCase().trim()
  if (ct.startsWith('image/')) return true
  if (ct.startsWith('video/')) return true
  if (ct.startsWith('audio/')) return true
  if (ct.startsWith('application/pdf')) return true
  if (ct.startsWith('application/octet-stream')) return true
  if (ct.startsWith('application/zip')) return true
  if (ct.startsWith('application/x-tar')) return true
  if (ct.startsWith('application/x-gzip')) return true
  if (ct.startsWith('application/vnd.openxmlformats-officedocument')) return true
  if (ct.startsWith('application/vnd.ms-')) return true
  return false
}

/**
 * Poll a port inside a sandbox via `curl --max-time 1 http://localhost:<port>/`
 * until it responds (exit 0) or the deadline passes.
 */
async function waitForPort(
  client: OpenSandboxClient,
  sandboxId: string,
  port: number,
  timeoutMs: number
): Promise<boolean> {
  // Use Python socket probe instead of curl — python:3.12-slim has no curl.
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
      // probe failed or timed out -- keep retrying
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

/**
 * Record a sandbox as retained in Redis with a TTL, schedule a delayed
 * destroy, and emit the `done` event with `kept=true`.
 */
async function retainAndEmit(
  client: OpenSandboxClient,
  sandboxId: string,
  executionId: string,
  emit: (event: LoaderEvent) => void
): Promise<void> {
  const retainUntil = new Date(Date.now() + RETAIN_SECONDS * 1000).toISOString()

  // Best-effort redis mark
  await markRetained(sandboxId, RETAIN_SECONDS)

  // Best-effort renew the sandbox TTL to match retention window
  try {
    await client.renew(sandboxId, RETAIN_SECONDS)
  } catch (e) {
    logger.warn('Failed to renew sandbox for retention', { sandboxId, error: e })
  }

  // Schedule delayed destroy (fire-and-forget)
  setTimeout(() => {
    client.destroy(sandboxId).catch((e) => {
      logger.warn('Delayed sandbox destroy failed', { sandboxId, error: e })
    })
  }, RETAIN_SECONDS * 1000)

  emit({
    type: 'done',
    executionId,
    sandboxId,
    kept: true,
    retainUntil,
  })
}

/**
 * Write a Redis key marking a sandbox as retained for debugging. The key
 * auto-expires via TTL so stale entries do not accumulate.
 */
async function markRetained(sandboxId: string, ttlSeconds: number): Promise<void> {
  const redis = getRedisClient()
  if (!redis) return
  try {
    await redis.set(`${RETAIN_KEY_PREFIX}${sandboxId}`, new Date().toISOString(), 'EX', ttlSeconds)
  } catch (e) {
    logger.warn('Redis markRetained failed (non-fatal)', { sandboxId, error: e })
  }
}

export type PhaseStep = 'sync' | 'cache-libs' | 'create-sandbox' | 'init' | 'start' | 'invoke'

export type PhaseStatus = 'start' | 'done' | 'error' | 'skip'

export interface PhaseEvent {
  type: 'phase'
  step: PhaseStep
  status: PhaseStatus
  durationMs?: number
  sandboxId?: string
  sizeBytes?: number
  httpStatus?: number
  reason?: string
  errorMessage?: string
}

export interface ResultEvent {
  type: 'result'
  success: boolean
  data?: unknown
  schemaError?: string
}

export interface DoneEvent {
  type: 'done'
  executionId: string
  sandboxId: string
  kept: boolean
  retainUntil?: string
}

/**
 * First event emitted by the run-test route — broadcasts the executionId
 * before any phase runs so the client can call
 * `/api/employee/tool-execution/[executionId]/files/*` for IO while the
 * sandbox is still booting (spec §9.5).
 */
export interface StartEvent {
  type: 'start'
  executionId: string
}

export type LoaderEvent = StartEvent | PhaseEvent | ResultEvent | DoneEvent

export interface RunFreshTestArgs {
  sessionId: string
  executionId: string
  input: Record<string, unknown>
  env: Record<string, unknown>
  extraEgress: string[]
  connectionId?: string
  emit: (event: LoaderEvent) => void
}

export async function runFreshTest(args: RunFreshTestArgs): Promise<void> {
  // Dev-studio uses sessionId as the toolId until adoption — keeps the
  // tools-workspace/<toolId>/code path stable across sync invocations.
  const toolId = args.sessionId

  // ── Step 1: sync ───────────────────────────────────────────────
  // Atomic copy workspace -> tools-workspace/<toolId>/code on the shared NFS
  // volume, then read the manifest out of the synced tool dir. Replaces the
  // legacy package + resolve + extract trio (MinIO upload + download + unzip).
  args.emit({ type: 'phase', step: 'sync', status: 'start' })
  const syncStart = Date.now()
  let syncResult: Awaited<ReturnType<typeof syncWorkspaceToCode>>
  try {
    syncResult = await syncWorkspaceToCode(args.sessionId, toolId)
  } catch (err) {
    const errorMessage = (err as Error).message
    logger.error('sync FAILED — workspace -> tools-workspace/<toolId>/code copy threw', {
      sessionId: args.sessionId,
      executionId: args.executionId,
      toolId,
      errorMessage,
      stack: err instanceof Error ? err.stack : undefined,
    })
    args.emit({
      type: 'phase',
      step: 'sync',
      status: 'error',
      errorMessage,
    })
    return
  }
  args.emit({
    type: 'phase',
    step: 'sync',
    status: syncResult.cached ? 'skip' : 'done',
    durationMs: Date.now() - syncStart,
    sizeBytes: syncResult.sizeBytes,
  })

  const manifest = await readManifestFromTool(toolId)
  if (!manifest) {
    logger.error('sync FAILED — manifest.json missing in synced code dir', {
      sessionId: args.sessionId,
      executionId: args.executionId,
      toolId,
    })
    args.emit({
      type: 'phase',
      step: 'sync',
      status: 'error',
      errorMessage: 'manifest missing after sync',
    })
    return
  }
  validateManifestDomains(manifest.dependencies.domains)
  const withDefaults = applyManifestDefaults(manifest)
  // Test sandbox follows the admin global egress mode (Model A′): unrestricted
  // → reach anything (the per-run ephemeral allowlist is irrelevant and hidden in the UI);
  // allowlist → deny-default with manifest domains ∪ global allow-lists ∪ the
  // per-run ephemeral allowlist (extraEgress) ∪ per-tool IPs ∪ system egress.
  const sandboxSettings = await getSandboxSettings()
  const networkPolicy = buildToolNetworkPolicy(
    sandboxSettings.egressMode,
    manifest.dependencies.domains,
    {
      globalDomains: sandboxSettings.allowedDomains,
      globalIps: sandboxSettings.allowedIps,
      extraDomains: args.extraEgress,
      toolIps: manifest.dependencies.ips,
    }
  )
  const mergedEnv: Record<string, string> = {
    ...defaultEnv(withDefaults),
    ...stringifyValues(args.env),
  }

  // Resolve the operator-selected system connection into CONN_* env vars and
  // inject them, mirroring the production invoke path
  // (app/api/employee/skills/instances/[id]/test-run). Without this a connector
  // tool tested from the dev-studio panel sees no CONN_* and fails at runtime
  // with "Missing database connection info in CONN_* environment variables".
  // CONN_* win over user-supplied env (Object.assign last) — they are the
  // authoritative credentials for the selected connection.
  if (args.connectionId) {
    try {
      Object.assign(mergedEnv, await resolveConnectionEnvVars(args.connectionId))
    } catch (err) {
      logger.warn('Failed to resolve connection env vars for test run', {
        sessionId: args.sessionId,
        executionId: args.executionId,
        connectionId: args.connectionId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // When the manifest declares file IO, copy the operator's persistent
  // per-session uploads into the sop-files dir scoped to this run's
  // sopExecId (the run-test executionId in test mode — production SOP uses
  // its own sopExecutionId). The sandbox mounts the sop-files **root** at
  // /root/io, so the tool sees its seeded inputs at
  // `/root/io/<sopExecId>/<filename>`.
  //
  // The reverse direction — output files written by the tool — is not
  // synced back: operators download them via
  // `/api/employee/tool-execution/<execId>/files/<name>`, which serves from
  // the same per-sopExecId dir.
  let needsIoMount = false
  if (withDefaults.needsFileMount) {
    const sessionRow = await sessionStore.get(args.sessionId)
    if (!sessionRow) {
      // Session vanished between auth check and seed — surface a sync error
      // rather than letting the sandbox boot against a half-built mount.
      logger.error('sync FAILED — session row disappeared before io seed', {
        sessionId: args.sessionId,
        executionId: args.executionId,
      })
      args.emit({
        type: 'phase',
        step: 'sync',
        status: 'error',
        errorMessage: `session ${args.sessionId} disappeared before seed`,
      })
      return
    }
    const seedResult = await seedSopFilesFromSession(
      args.sessionId,
      sessionRow.createdAt,
      args.executionId
    )
    needsIoMount = true
    logger.info({
      sessionId: args.sessionId,
      executionId: args.executionId,
      seededFiles: seedResult.copied,
      sopFilesDir: seedResult.sopFilesDir,
    }, 'seeded session io into sop-files (test mode: sopExecId = executionId)')
  }

  // ── Step 2: cache-libs ─────────────────────────────────────────
  const t4 = Date.now()
  args.emit({ type: 'phase', step: 'cache-libs', status: 'start' })

  const client = getOpenSandboxClient()
  const hasLibs = withDefaults.dependencies.libraries.length > 0

  if (!hasLibs) {
    args.emit({ type: 'phase', step: 'cache-libs', status: 'skip', reason: 'no libraries' })
  } else {
    try {
      // Always run the builder. pip dedupes already-satisfied packages itself;
      // a missing dependency fails loud HERE instead of masquerading as a
      // 30s port timeout at the start phase.
      await buildLibsViaBuilder(client, withDefaults)
      args.emit({ type: 'phase', step: 'cache-libs', status: 'done', durationMs: Date.now() - t4 })
    } catch (e) {
      args.emit({
        type: 'phase',
        step: 'cache-libs',
        status: 'error',
        durationMs: Date.now() - t4,
        errorMessage: e instanceof Error ? e.message : String(e),
      })
      return
    }
  }

  // ── Step 5: create-sandbox ─────────────────────────────────────
  const t5 = Date.now()
  args.emit({ type: 'phase', step: 'create-sandbox', status: 'start' })

  const pipIndexUrl = process.env.CREWMELD_SANDBOX_PIP_INDEX ?? ''
  const sandboxEnv: Record<string, string> = {
    ...mergedEnv,
    ...(hasLibs
      ? {
          PYTHONPATH: '/shared/site-packages',
          // pip install --target puts console_scripts (uvicorn, gunicorn,
          // fastapi-cli, etc.) into <target>/bin. Without this on PATH the
          // tool's start.sh `exec uvicorn ...` dies with "uvicorn: not
          // found" — the upstream "drop init pip install" change relies on
          // prewarmer-baked libs, so the bin dir has to be reachable.
          PATH: '/shared/site-packages/bin:/usr/local/bin:/usr/bin:/bin',
        }
      : {}),
    ...(pipIndexUrl ? { PIP_INDEX_URL: pipIndexUrl } : {}),
  }

  const image = withDefaults.image ?? DEFAULT_IMAGE
  const resourceLimits = withDefaults.resources?.limits ?? {
    cpu: '500m',
    memory: '512Mi',
    'ephemeral-storage': '1Gi',
  }

  // codeDir / shared site-packages / sop-files live on the shared NFS volume.
  // Sandbox hostPath must be the Linux view of the same data — derived via
  // paths.*.forSandbox(). Spec §12.1, F14 keeps /root/workspace RW.
  const volumes: Array<{ name: string; hostPath: string; mountPath: string; readOnly: boolean }> =
    []
  volumes.push({
    name: 'code',
    hostPath: paths.toolCode.forSandbox(toolId),
    mountPath: '/root/workspace',
    readOnly: false,
  })
  if (needsIoMount) {
    // Mount the sop-files ROOT (not the per-sopExecId subdir) so the tool
    // navigates by `_sopExecutionId` injected into its request body —
    // matching the production SOP runtime where the same long-lived service
    // pod serves multiple SOP executions out of distinct subdirs. Test mode
    // sopExecId == args.executionId, set up by the io-sync seed above.
    volumes.push({
      name: 'sop-files',
      hostPath: paths.sopFiles.forSandbox(),
      mountPath: '/root/io',
      readOnly: false,
    })
  }
  if (hasLibs) {
    volumes.unshift({
      name: 'site-packages',
      hostPath: paths.sharedLibs.forSandbox(),
      mountPath: '/shared/site-packages',
      readOnly: true,
    })
  }

  let sandboxId: string
  try {
    logger.info('Creating test sandbox', {
      image,
      volumes,
      egressMode: sandboxSettings.egressMode,
      egressCount: networkPolicy.egress?.length ?? 0,
    })
    const res = await client.createSandbox({
      image,
      entrypoint: ['sleep', '600'],
      resourceLimits,
      timeoutSeconds: TEST_SANDBOX_TIMEOUT_SECONDS,
      env: sandboxEnv,
      volumes: volumes.length > 0 ? volumes : undefined,
      networkPolicy,
      metadata: { 'crewmeld.purpose': 'test', 'crewmeld.session-id': args.sessionId },
    })
    sandboxId = res.id
    logger.info('Sandbox created, waiting for Running', { sandboxId })
    await client.waitUntilRunning(sandboxId, { timeoutMs: 60_000, intervalMs: 500 })
    logger.info('Sandbox is Running', { sandboxId })
  } catch (e) {
    logger.error('create-sandbox FAILED', {
      error: e instanceof Error ? e.message : e,
      stack: e instanceof Error ? e.stack : undefined,
    })
    throw e
  }

  args.emit({
    type: 'phase',
    step: 'create-sandbox',
    status: 'done',
    durationMs: Date.now() - t5,
    sandboxId,
  })

  try {
    // ── Step 6: init ───────────────────────────────────────────────
    const t6 = Date.now()
    args.emit({ type: 'phase', step: 'init', status: 'start' })
    // Dependencies are NOT pip-installed here: the cache-libs step already
    // installed manifest.dependencies.libraries into the shared site-packages
    // volume (mounted read-only at /shared/site-packages, exposed via
    // PYTHONPATH). The runtime sandbox has no outbound DNS by design, so a pip
    // install here would always fail (Name or service not known) and is
    // redundant. init.sh handles only non-pip one-time setup.
    const initResult = await client.exec({
      sandboxId,
      cmd: ['bash', '-c', 'set -e; cd /root/workspace; [ -f init.sh ] && bash init.sh; true'],
      timeoutMs: 300_000,
    })
    if (initResult.exitCode !== 0) {
      const errMsg = tail200(initResult.stderr || initResult.stdout)
      logger.error('init FAILED — pip install / init.sh non-zero exit', {
        sessionId: args.sessionId,
        executionId: args.executionId,
        sandboxId,
        exitCode: initResult.exitCode,
        durationMs: Date.now() - t6,
        stderrTail: tail200(initResult.stderr),
        stdoutTail: tail200(initResult.stdout),
      })
      args.emit({
        type: 'phase',
        step: 'init',
        status: 'error',
        durationMs: Date.now() - t6,
        sandboxId,
        errorMessage: `init step (init.sh) exited ${initResult.exitCode}: ${errMsg}`,
      })
      await retainAndEmit(client, sandboxId, args.executionId, args.emit)
      return
    }
    args.emit({
      type: 'phase',
      step: 'init',
      status: 'done',
      durationMs: Date.now() - t6,
      sandboxId,
    })

    // ── Step 7: start ──────────────────────────────────────────────
    const t7 = Date.now()
    args.emit({ type: 'phase', step: 'start', status: 'start' })

    if (withDefaults.kind !== 'service') {
      args.emit({ type: 'phase', step: 'start', status: 'skip', reason: 'kind=script' })
    } else {
      const servicePort = withDefaults.service!.port
      await client.exec({
        sandboxId,
        cmd: [
          'bash',
          '-c',
          'cd /root/workspace && nohup bash start.sh > /tmp/dev-studio-service.log 2>&1 &',
        ],
        timeoutMs: 5_000,
      })
      const portReady = await waitForPort(client, sandboxId, servicePort, 30_000)
      if (!portReady) {
        let logTail = ''
        try {
          const tailRes = await client.exec({
            sandboxId,
            cmd: ['tail', '-200', '/tmp/dev-studio-service.log'],
            timeoutMs: 5_000,
          })
          logTail = tailRes.stdout
        } catch {
          // non-fatal -- just include what we can
        }
        logger.error('start FAILED — service did not listen on declared port in 30s', {
          sessionId: args.sessionId,
          executionId: args.executionId,
          sandboxId,
          servicePort,
          durationMs: Date.now() - t7,
          serviceLogTail: tail200(logTail),
        })
        args.emit({
          type: 'phase',
          step: 'start',
          status: 'error',
          durationMs: Date.now() - t7,
          sandboxId,
          errorMessage: `Service did not become ready on port ${servicePort} within 30s.\n${tail200(logTail)}`,
        })
        await retainAndEmit(client, sandboxId, args.executionId, args.emit)
        return
      }
      args.emit({
        type: 'phase',
        step: 'start',
        status: 'done',
        durationMs: Date.now() - t7,
        sandboxId,
      })
    }

    // ── Step 8: invoke ─────────────────────────────────────────────
    const t8 = Date.now()
    args.emit({ type: 'phase', step: 'invoke', status: 'start' })

    let invokeResult: unknown
    let httpStatus: number | undefined

    if (withDefaults.kind === 'service') {
      const endpoint = await client.getEndpoint(sandboxId, withDefaults.service!.port)
      const servicePath = withDefaults.service!.path
      const serviceMethod = withDefaults.service!.method ?? 'POST'
      const url = `${endpoint}${servicePath}`

      const fetchHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        ...client.proxyHeaders(),
      }

      // Inject the file-IO metadata so the tool can navigate the shared
      // /root/io mount without computing dates itself:
      //   - `_sopExecutionId`: the SOP/test execution id (kept for logging
      //     and output-file naming — tools may want it in artefact names).
      //   - `_sopFileDir`:     relative path from the sandbox mount root
      //     to the per-SOP subdir, e.g. `2026/06/01/test_xxx`. Tools join
      //     this with the filename: `f"/root/io/{_sopFileDir}/{name}"`.
      //   - `_callId`:         unique-per-invocation id, optionally used
      //     by tools that need explicit unique output names (batch
      //     generators). BFF auto-handles collisions via (N) suffix in
      //     llm-tool-executor — so callId is informational, not required.
      // BFF computes everything once; tool code stays date-agnostic.
      // Matches the contract the intent-router injects for production SOP
      // calls (see lib/sop/llm-tool-executor.ts).
      const requestBody = needsIoMount
        ? {
            ...args.input,
            _sopExecutionId: args.executionId,
            _sopFileDir: paths.sopFiles.relPath(args.executionId),
            _callId: `call_${randomUUID().slice(0, 12)}`,
          }
        : args.input

      const res = await fetch(url, {
        method: serviceMethod,
        headers: fetchHeaders,
        body: serviceMethod !== 'GET' ? JSON.stringify(requestBody) : undefined,
        signal: AbortSignal.timeout(30_000),
      })

      httpStatus = res.status
      if (!res.ok) {
        const body = await res.text().catch(() => '(unreadable)')
        logger.error('invoke FAILED — service returned non-2xx', {
          sessionId: args.sessionId,
          executionId: args.executionId,
          sandboxId,
          url,
          method: serviceMethod,
          httpStatus,
          durationMs: Date.now() - t8,
          bodyTail: tail200(body),
        })
        args.emit({
          type: 'phase',
          step: 'invoke',
          status: 'error',
          durationMs: Date.now() - t8,
          sandboxId,
          httpStatus,
          errorMessage: `Service returned HTTP ${httpStatus}: ${tail200(body)}`,
        })
        await retainAndEmit(client, sandboxId, args.executionId, args.emit)
        return
      }

      // Parse response based on manifest output type
      const contentType = res.headers.get('content-type') ?? ''

      // Contract check — kind=service tools whose manifest declares a
      // file-typed output MUST return JSON with filenames, not stream the
      // binary back. The download flow reads bytes from /root/io; a binary
      // response gets corrupted by the text decode below AND never lands on
      // disk, so the operator's download link 404s or serves mangled bytes.
      // See persona-extensions item 8 file-output contract.
      const outputType = withDefaults.output?.type
      const expectsFileOutput =
        outputType === 'files' || outputType === 'image' || outputType === 'pdf'
      if (expectsFileOutput && isBinaryContentType(contentType)) {
        const msg =
          `Service returned binary response (Content-Type: ${contentType}) but ` +
          `manifest declares output.type="${outputType}". ` +
          `Tools must write outputs to /root/io/<_sopFileDir>/<name> and ` +
          `return JSON like {"output_file": "<name>"}. ` +
          `Forbidden: Response(content=bytes), FileResponse, StreamingResponse, ` +
          `send_file. See persona §8 file-output contract.`
        logger.error('invoke FAILED — binary response violates file-output contract', {
          sessionId: args.sessionId,
          executionId: args.executionId,
          sandboxId,
          contentType,
          outputType,
        })
        args.emit({
          type: 'phase',
          step: 'invoke',
          status: 'error',
          durationMs: Date.now() - t8,
          sandboxId,
          httpStatus,
          errorMessage: msg,
        })
        await retainAndEmit(client, sandboxId, args.executionId, args.emit)
        return
      }

      if (contentType.includes('application/json')) {
        invokeResult = (await res.json()) as unknown
      } else {
        const text = await res.text()
        try {
          invokeResult = JSON.parse(text) as unknown
        } catch {
          invokeResult = { raw: text }
        }
      }
    } else {
      // kind=script: exec start.sh with stdin. Same `_sopExecutionId` +
      // `_sopFileDir` + `_callId` injection as the service branch — the
      // script reads them from the parsed stdin JSON.
      const stdinBody = needsIoMount
        ? {
            ...args.input,
            _sopExecutionId: args.executionId,
            _sopFileDir: paths.sopFiles.relPath(args.executionId),
            _callId: `call_${randomUUID().slice(0, 12)}`,
          }
        : args.input
      const scriptResult = await client.exec({
        sandboxId,
        cmd: ['bash', '-c', 'cd /root/workspace && bash start.sh'],
        stdin: JSON.stringify(stdinBody),
        timeoutMs: 30_000,
      })

      if (scriptResult.exitCode !== 0) {
        logger.error('invoke FAILED — kind=script start.sh non-zero exit', {
          sessionId: args.sessionId,
          executionId: args.executionId,
          sandboxId,
          exitCode: scriptResult.exitCode,
          durationMs: Date.now() - t8,
          stderrTail: tail200(scriptResult.stderr),
          stdoutTail: tail200(scriptResult.stdout),
        })
        args.emit({
          type: 'phase',
          step: 'invoke',
          status: 'error',
          durationMs: Date.now() - t8,
          sandboxId,
          errorMessage: `start.sh exited ${scriptResult.exitCode}: ${tail200(scriptResult.stderr || scriptResult.stdout)}`,
        })
        await retainAndEmit(client, sandboxId, args.executionId, args.emit)
        return
      }

      // Parse the last non-empty stdout line as JSON
      const stdoutLines = scriptResult.stdout.split('\n').filter((l) => l.trim().length > 0)
      const lastLine = stdoutLines.at(-1) ?? ''
      try {
        invokeResult = JSON.parse(lastLine) as unknown
      } catch {
        invokeResult = { raw: scriptResult.stdout }
      }
    }

    args.emit({
      type: 'phase',
      step: 'invoke',
      status: 'done',
      durationMs: Date.now() - t8,
      sandboxId,
      httpStatus,
    })

    // ── Step 9: result ─────────────────────────────────────────────
    let schemaError: string | undefined
    if (withDefaults.output.type === 'json') {
      if (typeof invokeResult !== 'object' || invokeResult === null) {
        schemaError = `Expected JSON object output, got ${typeof invokeResult}`
      }
    }

    args.emit({
      type: 'result',
      success: true,
      data: invokeResult,
      schemaError,
    })

    // ── Step 10: cleanup ───────────────────────────────────────────
    try {
      await client.destroy(sandboxId)
    } catch (e) {
      logger.warn('Sandbox destroy failed (non-fatal)', { sandboxId, error: e })
    }
    args.emit({
      type: 'done',
      executionId: args.executionId,
      sandboxId,
      kept: false,
    })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    logger.error('runFreshTest threw — unhandled exception in steps 6-10', {
      sessionId: args.sessionId,
      executionId: args.executionId,
      sandboxId,
      errorMessage: msg,
      stack: e instanceof Error ? e.stack : undefined,
    })
    args.emit({
      type: 'phase',
      step: 'invoke',
      status: 'error',
      errorMessage: `Unexpected error: ${msg}`,
    })
    await retainAndEmit(client, sandboxId, args.executionId, args.emit)
  }
}

/**
 * Spawn a short-lived builder sandbox to run `pip install --target` and
 * populate the shared libs cache directory. Runs unconditionally on every
 * test that declares libraries; pip skips already-satisfied packages.
 */
async function buildLibsViaBuilder(
  client: OpenSandboxClient,
  manifest: ManifestT
): Promise<void> {
  const image = manifest.image ?? DEFAULT_IMAGE
  const pipIndexUrl = process.env.CREWMELD_SANDBOX_PIP_INDEX ?? ''
  const builderEnv: Record<string, string> = {
    ...(pipIndexUrl ? { PIP_INDEX_URL: pipIndexUrl } : {}),
  }

  // Builder mounts the shared-libs parent dir RW so `pip install --target
  // /build/site-packages` populates the same NFS site-packages that test
  // sandboxes RO-mount. defaultAction:'allow' — builder is transient infra
  // doing pip, not a runtime sandbox running untrusted tool code.
  const sharedLibsSandboxRoot = path.posix.dirname(paths.sharedLibs.forSandbox())
  const { id: builderId } = await client.createSandbox({
    image,
    entrypoint: ['sleep', '600'],
    resourceLimits: { cpu: '500m', memory: '512Mi', 'ephemeral-storage': '2Gi' },
    timeoutSeconds: BUILDER_TIMEOUT_SECONDS,
    env: builderEnv,
    volumes: [
      {
        name: 'build',
        hostPath: sharedLibsSandboxRoot,
        mountPath: '/build',
        readOnly: false,
      },
    ],
    networkPolicy: { defaultAction: 'allow' },
    metadata: { 'crewmeld.purpose': 'builder' },
  })

  try {
    await client.waitUntilRunning(builderId, { timeoutMs: 60_000, intervalMs: 500 })

    // Write requirements.txt into the builder sandbox
    const reqContent = manifest.dependencies.libraries.join('\n') + '\n'
    const files = await client.getFiles(builderId)
    await files.writeFiles([{ path: '/build/requirements.txt', data: reqContent }])

    // Run pip install
    const pipResult = await client.exec({
      sandboxId: builderId,
      cmd: [
        'pip',
        'install',
        '--target',
        '/build/site-packages',
        '-r',
        '/build/requirements.txt',
        '--no-input',
        '--quiet',
      ],
      timeoutMs: BUILDER_TIMEOUT_SECONDS * 1000,
    })

    if (pipResult.exitCode !== 0) {
      // Do NOT wipe the shared pool on failure — it holds other tools' packages.
      throw new Error(
        `Builder pip install failed (exit ${pipResult.exitCode}): ${tail200(pipResult.stderr || pipResult.stdout)}`
      )
    }

    logger.info('Builder completed libs install', {
      libraries: manifest.dependencies.libraries,
    })
  } finally {
    // Always destroy the builder
    await client.destroy(builderId).catch((destroyErr) => {
      logger.warn('Builder sandbox destroy failed', { builderId, error: destroyErr })
    })
  }
}
