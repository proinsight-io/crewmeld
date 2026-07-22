/**
 * Shared execution for durable async **api** and **http (long-running/service)** tools.
 *
 * Both kinds are, from the BFF's side, a bounded request/response: an api tool
 * runs `runApiTool` in-process (node:vm sandbox, 60s cap), an http tool POSTs to
 * a deployed endpoint. Neither can hand a callback to an external executor the
 * way a pod tool does, so the platform runs them itself. To survive a BFF
 * restart that work is driven by a BullMQ job (see async-tool-exec-worker); this
 * module is the run-once core both the worker and the no-Redis fallback share.
 *
 * NEVER throws: tool-level and transport errors are returned as a `failed`
 * callback body. That keeps BullMQ's job outcome meaning "the run was handled",
 * so the queue only marks a job failed on a genuine infra fault (crash / stall).
 */
import { createLogger } from '@crewmeld/logger'
import type { AsyncToolExecPayload } from '@/types/sop'
import type { ToolCallbackBody } from './tool-callback-handler'

const logger = createLogger('AsyncToolExecRun')

/**
 * Run an api/http tool and build the callback body describing its outcome.
 *
 * @param payload - The serialized dispatch context (kind-tagged).
 * @returns A {@link ToolCallbackBody} for {@link handleToolCallback}. Never rejects.
 */
export async function runAsyncToolExec(payload: AsyncToolExecPayload): Promise<ToolCallbackBody> {
  try {
    if (payload.kind === 'api') {
      const { runApiTool } = await import('@/lib/tools/api-tool-runner')
      const { buildApiToolDeps } = await import('@/lib/tools/api-tool-deps')
      const r = await runApiTool(payload.apiSpec, payload.args, buildApiToolDeps(), {
        toolId: payload.toolId,
        forwardIdentity: payload.forwardIdentity,
        identity: payload.identity,
      })
      return r.success
        ? { callId: payload.callId, status: 'completed', result: r.result ?? null }
        : { callId: payload.callId, status: 'failed', error: r.error ?? 'Unknown error' }
    }

    // kind === 'http' — deployed service / k8s tool at a persistent endpoint.
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (payload.useProxy) {
      const apiKey = process.env.OPENSANDBOX_API_KEY
      if (apiKey) headers['OPEN-SANDBOX-API-KEY'] = apiKey
    }
    const resp = await fetch(payload.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload.requestBody),
    })

    if (payload.envelopeMode === 'opensandbox') {
      // dev-studio service tools return the tool's raw HTTP response; synthesise
      // the success/result/error envelope here (matches finalize-at-call-boundary).
      const text = await resp.text()
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = { raw: text }
      }
      return resp.ok
        ? { callId: payload.callId, status: 'completed', result: parsed }
        : {
            callId: payload.callId,
            status: 'failed',
            error: typeof parsed === 'string' ? parsed : JSON.stringify(parsed),
          }
    }

    // Standard envelope: the endpoint already returns { success, result, error }.
    const j = (await resp.json()) as { success?: boolean; result?: unknown; error?: string }
    return j.success !== false
      ? { callId: payload.callId, status: 'completed', result: j.result ?? j }
      : { callId: payload.callId, status: 'failed', error: j.error ?? 'Unknown error' }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    logger.error('async tool exec run failed', { callId: payload.callId, kind: payload.kind, error })
    return { callId: payload.callId, status: 'failed', error }
  }
}
