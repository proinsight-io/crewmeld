/**
 * Dispatch a tool call asynchronously: journal a `pending` work-log row, kick
 * the work off in the background, and return immediately so the SOP can suspend.
 *
 * Completion flows back per tool kind:
 *
 *  - **api / http (long-running service)** tools run on the BFF, so they're handed to the
 *    durable `sop-async-tool-exec` queue: the exec worker runs the tool and
 *    applies the result in-process via the callback handler. Because the job
 *    lives in Redis, a BFF restart mid-call re-runs it instead of losing an
 *    in-memory promise. When no Redis is configured, a detached in-process run is
 *    used as a fallback (netted by the watchdog).
 *  - **script / service pod** tools run inside their pod via a platform-assembled
 *    wrapper. The wrapper runs the tool code, then a tiny python relay POSTs the
 *    raw result to the HTTP callback route (`/api/sop/[executionId]/tool-callback`,
 *    body `{ callId, token, status, result?, error? }`). The pod is kept alive
 *    until the callback (or watchdog) tears it down. The callback URL + token are
 *    written into the pod as data files — the tool's own code never sees them.
 *
 * Dispatch is decoupled from the callback handler / SOP resume, so it can be
 * built and type-checked independently.
 */
import { createLogger } from '@crewmeld/logger'
import { getSandboxCallbackBaseUrl } from '@/lib/core/utils/urls'
import type { ScopeIdentity } from '@/lib/identity/types'
import type { ApiToolSpec } from '@/lib/tools/api-tool-types'
import type { AsyncToolExecPayload } from '@/types/sop'
import { signCallbackToken } from './async-tool-callback-token'
import { failToolCallLog, writePendingToolCallLog } from './async-tool-log'

const logger = createLogger('AsyncToolDispatch')

/** Best-effort HTTP timeout for the per-file writes + launch ack inside a pod. */
const POD_SETUP_TIMEOUT_MS = 8_000

/** Common identity fields shared by every dispatch kind. */
interface DispatchBase {
  executionId: string
  nodeId: string
  /** Node execution task — the rebuild/resume key. */
  taskId: string
  employeeId: string
  round: number
  /** Stable id correlating this dispatch with its callback. */
  callId: string
  toolName: string
  toolId: string
  instanceName: string
  /** Parsed LLM arguments (journaled for rebuild). */
  args: Record<string, unknown>
}

export interface DispatchApiToolParams extends DispatchBase {
  kind: 'api'
  apiSpec: ApiToolSpec
  apiForwardIdentity?: boolean
  identity?: ScopeIdentity
}

export interface DispatchPodToolParams extends DispatchBase {
  /** Dev-studio script tools run in a fresh pod per call (deployType opensandbox-script). */
  kind: 'script'
  /** Template id used by prepareToolSandbox to locate the tool code. */
  templateId: string
  /** Env resolved from the instance row. */
  userEnv: Record<string, string>
  /** Request body the loop assembled (identity + _sop* fields already merged). */
  requestBody: Record<string, unknown>
}

export interface DispatchHttpToolParams extends DispatchBase {
  /** Deployed service / k8s tools reached over HTTP at a persistent endpoint. */
  kind: 'http'
  endpoint: string
  /** Request body the loop assembled. */
  requestBody: Record<string, unknown>
  /** Add the OpenSandbox proxy auth header when reaching the endpoint via proxy. */
  useProxy?: boolean
  /**
   * 'opensandbox' → the endpoint returns the tool's raw HTTP response and the
   * success/result/error envelope is synthesised here; 'standard' → the
   * endpoint already returns a `{ success, result, error }` envelope.
   */
  envelopeMode: 'opensandbox' | 'standard'
}

export interface DispatchImmediateParams extends DispatchBase {
  /** Tool call that fails before any real work (unknown tool / fail-closed identity). */
  kind: 'immediate'
  error: string
}

export type DispatchAsyncToolParams =
  | DispatchApiToolParams
  | DispatchPodToolParams
  | DispatchHttpToolParams
  | DispatchImmediateParams

/** Assemble the absolute callback URL for an execution. */
function callbackUrl(executionId: string): string {
  return `${getSandboxCallbackBaseUrl().replace(/\/$/, '')}/api/sop/${encodeURIComponent(executionId)}/tool-callback`
}

/** Liveness ceiling before a never-called-back tool is failed. Override via
 *  CREWMELD_ASYNC_TOOL_WATCHDOG_MINUTES. */
const WATCHDOG_DEFAULT_MINUTES = 30

function watchdogDelayMs(): number {
  const m = Number(process.env.CREWMELD_ASYNC_TOOL_WATCHDOG_MINUTES)
  return (Number.isFinite(m) && m > 0 ? m : WATCHDOG_DEFAULT_MINUTES) * 60_000
}

/**
 * Schedule the watchdog that fails this call if no callback arrives. Returns the
 * job id (stored on the pending row so the callback can cancel it), or undefined
 * when no queue is configured — dispatch still proceeds, just without a net.
 */
async function registerWatchdog(executionId: string, callId: string): Promise<string | undefined> {
  try {
    const { getAsyncToolWatchdogQueue } = await import('./queue')
    const queue = getAsyncToolWatchdogQueue()
    if (!queue) return undefined
    const job = await queue.add(
      'async-tool-watchdog',
      { executionId, callId },
      { delay: watchdogDelayMs() }
    )
    return job.id
  } catch (e) {
    logger.warn('Failed to register async tool watchdog', {
      executionId,
      callId,
      error: e instanceof Error ? e.message : String(e),
    })
    return undefined
  }
}

/**
 * Python relay (stdlib only, double-quotes only) executed inside the pod after
 * the tool finishes. Reads the callback descriptor + the tool's stdout/stderr
 * from data files and POSTs `{ callId, token, status, result|error }` back.
 */
const POD_CALLBACK_PY = `
import urllib.request, json, os
meta = json.load(open("/root/_async_meta.json"))
rc = 1
try:
    rc = int(open("/root/_async_rc").read().strip())
except Exception:
    pass
out = ""
try:
    out = open("/root/_async_out.txt").read()
except Exception:
    pass
err = ""
try:
    err = open("/root/_async_err.log").read()
except Exception:
    pass
body = {"callId": meta["callId"], "token": meta["token"]}
if rc == 0:
    try:
        body["result"] = json.loads(out) if out.strip() else None
    except Exception:
        body["result"] = {"raw": out}
    body["status"] = "completed"
else:
    body["status"] = "failed"
    body["error"] = (err or out or ("exit code " + str(rc)))[:4000]
data = json.dumps(body).encode()
req = urllib.request.Request(meta["callbackUrl"], data=data, headers={"Content-Type": "application/json"})
try:
    urllib.request.urlopen(req, timeout=30)
except Exception:
    pass
`.trim()

/** Runner for a script tool: feed payload on stdin, capture stdout, then relay. */
const SCRIPT_RUNNER_SH = `
cd /root/workspace
bash start.sh < /root/_async_payload.json > /root/_async_out.txt 2> /root/_async_err.log
echo $? > /root/_async_rc
python3 /root/_async_callback.py
`.trim()

/** Write a UTF-8 file into the pod via execd stdin (quote-safe). */
async function writePodFile(
  client: { exec: (a: { sandboxId: string; stdin?: string; cmd: string[]; timeoutMs?: number }) => Promise<unknown> },
  sandboxId: string,
  path: string,
  content: string
): Promise<void> {
  await client.exec({
    sandboxId,
    stdin: content,
    cmd: ['bash', '-c', `cat > ${path}`],
    timeoutMs: POD_SETUP_TIMEOUT_MS,
  })
}

/**
 * Hand a BFF-side async tool (api / http) to the durable exec queue so it
 * survives a BFF restart. When no queue is configured (no Redis) fall back to an
 * in-process detached run — the pre-queue behaviour, minus restart durability,
 * netted by the watchdog. Both paths complete via the in-process callback
 * handler (the worker runs inside the BFF, so no HTTP round-trip / token needed).
 */
async function enqueueOrRunAsyncToolExec(payload: AsyncToolExecPayload): Promise<void> {
  const { getAsyncToolExecQueue } = await import('./queue')
  const queue = getAsyncToolExecQueue()
  if (queue) {
    // jobId = callId dedups an accidental double-dispatch of the same call.
    await queue.add('exec', payload, { jobId: payload.callId })
    return
  }

  // No Redis: run detached in this process (lost on restart, but the watchdog
  // still fails the pending row so the SOP does not hang forever).
  void (async () => {
    const { runAsyncToolExec } = await import('./async-tool-exec-run')
    const { handleToolCallback } = await import('./tool-callback-handler')
    const body = await runAsyncToolExec(payload)
    try {
      await handleToolCallback(payload.executionId, body)
    } catch (e) {
      logger.error('fallback async tool exec callback apply failed', {
        callId: payload.callId,
        error: e instanceof Error ? e.message : String(e),
      })
    }
  })()
}

/** Dispatch an api tool onto the durable exec queue; the SOP suspends meanwhile. */
async function dispatchApiToolAsync(p: DispatchApiToolParams): Promise<void> {
  const watchdogJobId = await registerWatchdog(p.executionId, p.callId)

  await writePendingToolCallLog({
    taskId: p.taskId,
    employeeId: p.employeeId,
    executionId: p.executionId,
    nodeId: p.nodeId,
    round: p.round,
    callId: p.callId,
    toolName: p.toolName,
    toolId: p.toolId,
    instanceName: p.instanceName,
    input: p.args,
    watchdogJobId,
  })

  await enqueueOrRunAsyncToolExec({
    kind: 'api',
    executionId: p.executionId,
    callId: p.callId,
    toolId: p.toolId,
    apiSpec: p.apiSpec,
    args: p.args,
    forwardIdentity: p.apiForwardIdentity,
    identity: p.identity,
  })
}

/** Dispatch a pod (script/service) tool via an in-pod wrapper that calls back. */
async function dispatchPodToolAsync(p: DispatchPodToolParams): Promise<void> {
  const url = callbackUrl(p.executionId)
  const token = signCallbackToken(p.executionId, p.callId)

  const { prepareToolSandbox } = await import('@/lib/tools/tool-sandbox')
  const prepared = await prepareToolSandbox({
    toolId: p.templateId,
    input: p.requestBody,
    userEnv: p.userEnv,
    purpose: 'async-invoke',
  })
  const { client, sandboxId, payload, destroy } = prepared

  try {
    const watchdogJobId = await registerWatchdog(p.executionId, p.callId)
    await writePendingToolCallLog({
      taskId: p.taskId,
      employeeId: p.employeeId,
      executionId: p.executionId,
      nodeId: p.nodeId,
      round: p.round,
      callId: p.callId,
      toolName: p.toolName,
      toolId: p.toolId,
      instanceName: p.instanceName,
      input: p.args,
      sandboxId,
      watchdogJobId,
    })

    await writePodFile(client, sandboxId, '/root/_async_payload.json', JSON.stringify(payload))
    await writePodFile(
      client,
      sandboxId,
      '/root/_async_meta.json',
      JSON.stringify({ callId: p.callId, token, callbackUrl: url })
    )
    await writePodFile(client, sandboxId, '/root/_async_callback.py', POD_CALLBACK_PY)

    await writePodFile(client, sandboxId, '/root/_async_run.sh', SCRIPT_RUNNER_SH)

    // Launch detached; the exec returns as soon as the background job is forked.
    await client.exec({
      sandboxId,
      cmd: ['bash', '-c', 'cd /root && nohup bash _async_run.sh >/root/_async_launch.log 2>&1 & echo accepted'],
      timeoutMs: POD_SETUP_TIMEOUT_MS,
    })
  } catch (e) {
    // Setup/launch failed before any callback can fire — tear the pod down and
    // fail the pending row so the SOP doesn't hang waiting for a callback that
    // will never come.
    const msg = e instanceof Error ? e.message : String(e)
    logger.error('async pod tool dispatch failed', { callId: p.callId, sandboxId, error: msg })
    await destroy()
    await failToolCallLog(p.callId, msg)
  }
}

/**
 * Dispatch a deployed-service / k8s HTTP tool (the tool code has no callback
 * logic, so the platform calls the endpoint and applies the result). The work is
 * handed to the durable exec queue rather than run in a BFF-memory task, so a BFF
 * restart mid-call is recovered by re-running the job instead of hanging until
 * the watchdog. See {@link enqueueOrRunAsyncToolExec}.
 */
async function dispatchHttpToolAsync(p: DispatchHttpToolParams): Promise<void> {
  const watchdogJobId = await registerWatchdog(p.executionId, p.callId)

  await writePendingToolCallLog({
    taskId: p.taskId,
    employeeId: p.employeeId,
    executionId: p.executionId,
    nodeId: p.nodeId,
    round: p.round,
    callId: p.callId,
    toolName: p.toolName,
    toolId: p.toolId,
    instanceName: p.instanceName,
    input: p.args,
    watchdogJobId,
  })

  await enqueueOrRunAsyncToolExec({
    kind: 'http',
    executionId: p.executionId,
    callId: p.callId,
    toolId: p.toolId,
    endpoint: p.endpoint,
    requestBody: p.requestBody,
    useProxy: p.useProxy,
    envelopeMode: p.envelopeMode,
  })
}

/**
 * Dispatch an immediate-failure tool call: journal the pending row then POST a
 * failed callback so the same callback → resume path drives the round to
 * completion (works even when every call in the round fails synchronously).
 */
async function dispatchImmediateAsync(p: DispatchImmediateParams): Promise<void> {
  const url = callbackUrl(p.executionId)
  const token = signCallbackToken(p.executionId, p.callId)

  await writePendingToolCallLog({
    taskId: p.taskId,
    employeeId: p.employeeId,
    executionId: p.executionId,
    nodeId: p.nodeId,
    round: p.round,
    callId: p.callId,
    toolName: p.toolName,
    toolId: p.toolId,
    instanceName: p.instanceName,
    input: p.args,
  })

  void (async () => {
    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callId: p.callId, token, status: 'failed', error: p.error }),
      })
    } catch (err) {
      logger.error('immediate-failure self-callback POST failed', {
        callId: p.callId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  })()
}

/** Route a tool call to the right async dispatcher by kind. */
export async function dispatchAsyncToolCall(params: DispatchAsyncToolParams): Promise<void> {
  if (params.kind === 'api') {
    await dispatchApiToolAsync(params)
  } else if (params.kind === 'script') {
    await dispatchPodToolAsync(params)
  } else if (params.kind === 'http') {
    await dispatchHttpToolAsync(params)
  } else {
    await dispatchImmediateAsync(params)
  }
}
