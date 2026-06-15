/**
 * Test runner for Dev Studio: executes user-built tools inside their
 * OpenSandbox container via the standard workspace `start.sh` entry.
 *
 * Two shapes:
 *  - {@link runScript}: one-shot CLI tool. Params JSON-stringified onto stdin,
 *    stdout captured as the result.
 *  - {@link runService} (added in Task 4.3): long-running HTTP service. Probes
 *    the declared port, starts the service in the background if needed, then
 *    issues an in-container `curl` to the declared endpoint.
 *
 * All calls go through `bash start.sh` at the workspace root so the AI Engineer
 * persona has a single, predictable launch entry (spec §3 decision table).
 */

import * as openSandbox from './opensandbox-client'

export interface RunScriptArgs {
  sandboxId: string
  /** Free-form params object; serialized as the script's stdin payload. */
  params: Record<string, unknown>
  /** Default 30 000 ms. */
  timeoutMs?: number
}

export type RunScriptResult = openSandbox.ExecResult

/**
 * @deprecated Spec B-era same-container exec. Replaced by runFreshTest in
 * sandbox-loader.ts. Will be removed once all callers are migrated.
 *
 * Run a kind=script tool: one-shot `bash start.sh` execution at the workspace
 * root with JSON-stringified params piped to stdin.
 *
 * The launch script is expected to read stdin, do its work, and write the
 * tool result to stdout. Non-zero exitCode is *not* translated to a thrown
 * error here — the caller (BFF /run-test route) decides how to surface
 * failures to the UI.
 */
export async function runScript(args: RunScriptArgs): Promise<RunScriptResult> {
  return openSandbox.exec({
    sandboxId: args.sandboxId,
    cmd: ['bash', '-c', 'cd /root/workspace && bash start.sh'],
    stdin: JSON.stringify(args.params),
    timeoutMs: args.timeoutMs ?? 30_000,
  })
}

/** Log path the nohup launcher streams stdout+stderr into for tail-on-failure. */
const SERVICE_LOG_PATH = '/tmp/dev-studio-service.log' as const
/** How long {@link waitForPort} polls before giving up (ms). */
const PORT_READY_TIMEOUT_MS = 10_000
/** Poll interval between port probes (ms). */
const PORT_POLL_INTERVAL_MS = 200

export interface ServiceDescriptor {
  port: number
  /** Request path starting with '/'. */
  path: string
  /** HTTP method: GET/POST/PUT/DELETE/PATCH. */
  method: string
}

export interface RunServiceArgs {
  sandboxId: string
  service: ServiceDescriptor
  params: Record<string, unknown>
  /** Default 30 000 ms — applies only to the final curl call. */
  timeoutMs?: number
}

export interface RunServiceResult extends openSandbox.ExecResult {
  /** HTTP status code parsed from the final line of curl's output. */
  httpStatus?: number
}

/**
 * Probe an in-container HTTP port by running a short curl that prints only
 * the status code. Any 2xx/3xx/4xx/5xx response means *something* is
 * listening and we treat it as healthy — even a 404 implies the server is up.
 *
 * Output `000` (curl's failure indicator) means no connection at all.
 */
async function checkPort(sandboxId: string, port: number): Promise<boolean> {
  const probe = await openSandbox.exec({
    sandboxId,
    cmd: [
      'bash',
      '-c',
      `curl -o /dev/null -s -w '%{http_code}' http://localhost:${port}/ || echo "000"`,
    ],
    timeoutMs: 2_000,
  })
  return /^[2-5]\d\d$/.test(probe.stdout.trim())
}

/**
 * Poll {@link checkPort} every {@link PORT_POLL_INTERVAL_MS} until either the
 * port responds or `timeoutMs` elapses. Returns the final health state.
 */
async function waitForPort(sandboxId: string, port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await checkPort(sandboxId, port)) return true
    await new Promise((r) => setTimeout(r, PORT_POLL_INTERVAL_MS))
  }
  return false
}

/**
 * Single-quote-wrap a JSON body for safe interpolation into a bash command
 * built with single quotes. Embedded `'` becomes `'\''` (close-quote, escaped
 * literal, reopen-quote) — the standard POSIX trick.
 */
function quoteForShell(json: string): string {
  return `'${json.replace(/'/g, "'\\''")}'`
}

/**
 * @deprecated Spec B-era same-container exec. Replaced by runFreshTest in
 * sandbox-loader.ts. Will be removed once all callers are migrated.
 *
 * Run a kind=service tool: probe the declared port, start the service in
 * detached background mode if it is not already up, wait for readiness,
 * then issue an HTTP request via in-container `curl` and parse the response.
 *
 * Why curl-in-container rather than going through the SDK endpoint? The
 * service may bind to an internal port that isn't exposed via getEndpoint, and
 * the AI Engineer can keep the start script identical for both kinds (spec §3
 * decision table).
 *
 * httpStatus is parsed from the trailing `\n%{http_code}` line; the body is
 * everything before it.
 */
export async function runService(args: RunServiceArgs): Promise<RunServiceResult> {
  const { sandboxId, service, params } = args
  const { port, path: svcPath, method } = service

  let healthy = await checkPort(sandboxId, port)
  if (!healthy) {
    await openSandbox.exec({
      sandboxId,
      cmd: [
        'bash',
        '-c',
        `cd /root/workspace && nohup bash start.sh > ${SERVICE_LOG_PATH} 2>&1 &`,
      ],
      timeoutMs: 5_000,
    })
    healthy = await waitForPort(sandboxId, port, PORT_READY_TIMEOUT_MS)
    if (!healthy) {
      const tail = await openSandbox.exec({
        sandboxId,
        cmd: ['bash', '-c', `tail -50 ${SERVICE_LOG_PATH}`],
        timeoutMs: 2_000,
      })
      throw new Error(
        `Service did not start within ${PORT_READY_TIMEOUT_MS}ms. ` +
          `Last lines from ${SERVICE_LOG_PATH}:\n${tail.stdout}`
      )
    }
  }

  const body = quoteForShell(JSON.stringify(params))
  const curlCmd =
    `curl -X ${method} -sS -w '\\n%{http_code}' localhost:${port}${svcPath} ` +
    `-H 'Content-Type: application/json' -d ${body}`
  const result = await openSandbox.exec({
    sandboxId,
    cmd: ['bash', '-c', curlCmd],
    timeoutMs: args.timeoutMs ?? 30_000,
  })

  const lines = result.stdout.split('\n')
  const last = lines.at(-1) ?? ''
  const parsedStatus = Number.parseInt(last, 10)
  const httpStatus = Number.isFinite(parsedStatus) && parsedStatus > 0 ? parsedStatus : undefined
  const responseBody = lines.slice(0, -1).join('\n')

  return { ...result, stdout: responseBody, httpStatus }
}

export { runFreshTest } from './sandbox-loader'
