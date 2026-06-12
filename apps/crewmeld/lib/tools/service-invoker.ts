/**
 * Ephemeral container invoker for service-type (long-running HTTP) dev-studio
 * tools.
 *
 * Reuses {@link prepareToolSandbox} for the identical create/mount/teardown
 * lifecycle, then — because a service's `start.sh` runs a blocking HTTP server
 * that never exits — pulls the result out differently from a script:
 *   1. Launch the server in the background (`nohup bash start.sh &`).
 *   2. Poll the declared port until it listens (Python socket probe — the tool
 *      image, e.g. python:3.12-slim, has no curl).
 *   3. Resolve the sandbox endpoint and call it from the BFF via `fetch`
 *      (image-agnostic; does not depend on curl being installed in the tool).
 *   4. Destroy the sandbox.
 *
 * Mirrors the proven dev-studio run-test service path (sandbox-loader.ts).
 */

import { createLogger } from '@crewmeld/logger'
import type { OpenSandboxClient } from '@/lib/dev-studio/opensandbox-client'
import { prepareToolSandbox } from './tool-sandbox'

const logger = createLogger('ServiceInvoker')

/** Service must begin listening within this window after background launch. */
const PORT_READY_TIMEOUT_MS = 30_000
/** Poll interval between port probes (ms). */
const PORT_POLL_INTERVAL_MS = 500
/** Timeout for the final HTTP call to the service endpoint (ms). */
const SERVICE_CALL_TIMEOUT_MS = 60_000
/** In-container log file the background launcher streams stdout+stderr into. */
const SERVICE_LOG_PATH = '/tmp/crewmeld-service.log'

export interface ServiceInvokeArgs {
  /** Template id used as the on-disk tool identifier under `tools-workspace/`. */
  toolId: string
  /** Caller-supplied input payload — sent as the HTTP request body. */
  input: unknown
  /** Environment variables resolved from the instance row (envVars). */
  userEnv: Record<string, string>
  /** Optional pre-allocated execution id. */
  execId?: string
  /** Caller's forwardable inbound HTTP headers. */
  headers?: Record<string, string>
}

export interface ServiceInvokeResult {
  success: boolean
  result?: unknown
  error?: string
  /** HTTP status code returned by the service endpoint. */
  httpStatus?: number
  executionTime: number
}

/**
 * Poll the declared port until it accepts a TCP connection or the timeout
 * elapses. Uses a Python socket probe (exit 0 = listening) rather than curl —
 * the tool runtime image (python:3.12-slim) ships no curl. Matches
 * sandbox-loader.ts's waitForPort.
 */
async function waitForPort(
  client: OpenSandboxClient,
  sandboxId: string,
  port: number
): Promise<boolean> {
  const probeCmd =
    `python3 -c "import socket; s=socket.socket(); s.settimeout(1); ` +
    `s.connect(('localhost',${port})); s.close()"`
  const deadline = Date.now() + PORT_READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      const res = await client.exec({
        sandboxId,
        cmd: ['bash', '-c', probeCmd],
        timeoutMs: 5_000,
      })
      if (res.exitCode === 0) return true
    } catch {
      // probe failed or timed out — keep retrying until the deadline
    }
    await new Promise((r) => setTimeout(r, PORT_POLL_INTERVAL_MS))
  }
  return false
}

export async function invokeServiceTool(args: ServiceInvokeArgs): Promise<ServiceInvokeResult> {
  const start = Date.now()

  let prepared: Awaited<ReturnType<typeof prepareToolSandbox>>
  try {
    prepared = await prepareToolSandbox({ ...args, purpose: 'service-invoke' })
  } catch (e) {
    return {
      success: false,
      error: e instanceof Error ? e.message : String(e),
      executionTime: Date.now() - start,
    }
  }

  const { client, sandboxId, withDefaults, payload, destroy } = prepared
  const service = withDefaults.service
  if (!service) {
    await destroy()
    return {
      success: false,
      error: 'Tool manifest declares kind=service but has no service block.',
      executionTime: Date.now() - start,
    }
  }
  const { port, path: svcPath } = service
  const method = service.method ?? 'POST'

  try {
    // 1. Launch the service in the background (start.sh blocks while serving).
    await client.exec({
      sandboxId,
      cmd: [
        'bash',
        '-c',
        `cd /root/workspace && nohup bash start.sh > ${SERVICE_LOG_PATH} 2>&1 &`,
      ],
      timeoutMs: 5_000,
    })

    // 2. Wait for the declared port to start listening.
    const ready = await waitForPort(client, sandboxId, port)
    if (!ready) {
      const tail = await client
        .exec({
          sandboxId,
          cmd: ['bash', '-c', `tail -50 ${SERVICE_LOG_PATH} 2>/dev/null || true`],
          timeoutMs: 3_000,
        })
        .catch(() => ({ stdout: '' }))
      return {
        success: false,
        error:
          `Service did not start listening on port ${port} within ` +
          `${PORT_READY_TIMEOUT_MS / 1000}s. Last lines from ${SERVICE_LOG_PATH}:\n${tail.stdout}`,
        executionTime: Date.now() - start,
      }
    }

    // 3. Call the declared endpoint from the BFF (image-agnostic — no curl
    //    needed in the tool container). getEndpoint resolves the sandbox URL;
    //    proxyHeaders carries the OpenSandbox proxy auth when in proxy mode.
    const endpoint = await client.getEndpoint(sandboxId, port)
    const url = `${endpoint}${svcPath}`
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', ...client.proxyHeaders() },
      body: method !== 'GET' ? JSON.stringify(payload) : undefined,
      signal: AbortSignal.timeout(SERVICE_CALL_TIMEOUT_MS),
    })

    const httpStatus = res.status
    const text = await res.text().catch(() => '')
    let parsed: unknown
    try {
      parsed = text.length > 0 ? JSON.parse(text) : null
    } catch {
      parsed = { raw: text }
    }

    if (!res.ok) {
      logger.warn('Service tool returned non-2xx', { sandboxId, httpStatus })
      return {
        success: false,
        error: `Service returned HTTP ${httpStatus}`,
        result: parsed,
        httpStatus,
        executionTime: Date.now() - start,
      }
    }

    return { success: true, result: parsed, httpStatus, executionTime: Date.now() - start }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    logger.error('Service tool invocation failed', { sandboxId, error: msg })
    return { success: false, error: msg, executionTime: Date.now() - start }
  } finally {
    await destroy()
  }
}
