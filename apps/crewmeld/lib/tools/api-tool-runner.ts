import { createLogger } from '@crewmeld/logger'
import { callCustomApi } from '@/lib/connectors/call-custom-api'
import { runInSandbox } from './js-sandbox'
import { buildPresetLibs } from './preset-libs'
import type {
  ApiCallParams,
  ApiCallResult,
  ApiToolContext,
  ApiToolRunnerDeps,
  ApiToolSpec,
} from './api-tool-types'
import type { ConnectionConfig } from '@/lib/connectors/types'
import type { ScopeIdentity } from '@/lib/identity/types'

const logger = createLogger('ApiToolRunner')

const MAX_CALL_DEPTH = 5
const TOTAL_TIMEOUT_MS = 60_000

/** Result returned by {@link runApiTool}. */
export interface RunApiToolResult {
  success: boolean
  result?: unknown
  error?: string
  /** Stage where failure occurred, for diagnostics. */
  stage?: 'pre' | 'request' | 'post'
}

/** Options controlling cycle detection, depth limiting, and identity forwarding. */
export interface RunApiToolOptions {
  /** Chain of tool ids already on the call stack (cycle detection). */
  callStack?: string[]
  /** This tool's own id (for cycle detection / depth). */
  toolId?: string
  /**
   * When true, the platform injects the caller's resolved identity into the
   * outgoing HTTP request. Method-aware:
   * - GET / HEAD / DELETE → added as `X-Identity` header (JSON-encoded).
   * - POST / PUT / PATCH  → merged into the request body as `.identity`.
   *
   * Fail-closed: if `forwardIdentity` is set but `identity` is absent, the
   * call is rejected immediately (no fetch) with `success: false`.
   */
  forwardIdentity?: boolean
  /** Platform-resolved caller identity. Never sourced from the LLM. */
  identity?: ScopeIdentity
  /**
   * Caller's inbound HTTP headers (filtered to the forwardable subset by the
   * invoke route). Exposed as `ctx.headers` and overlaid on the primary
   * outbound call's headers (pre-set headers win). Absent for non-HTTP callers.
   */
  headers?: Record<string, string>
}

/**
 * Execute a single API tool: pre → primary callApi → post.
 *
 * @param spec   The stored {@link ApiToolSpec} for this tool.
 * @param input  Raw input data from the caller (available as `scope.input` in sandbox code).
 * @param deps   Injected dependencies — use mocks in tests.
 * @param options  Optional cycle-detection / depth context when called from another tool.
 */
export async function runApiTool(
  spec: ApiToolSpec,
  input: unknown,
  deps: ApiToolRunnerDeps,
  options: RunApiToolOptions = {}
): Promise<RunApiToolResult> {
  const callStack = options.callStack ?? []
  const presetLibs = buildPresetLibs()

  /** Resolve a connection and perform a custom_api HTTP call. */
  async function callApi(connectionId: string, params: ApiCallParams = {}): Promise<ApiCallResult> {
    const resolved = await deps.resolveConnection(connectionId)
    if (!resolved) throw new Error(`connection not found: ${connectionId}`)
    if (resolved.type !== 'custom_api') {
      throw new Error(`connection ${connectionId} is not custom_api (got ${resolved.type})`)
    }
    return callCustomApi(resolved.config as ConnectionConfig, params)
  }

  /** Invoke another tool by id, with cycle and depth guards. */
  async function callTool(toolId: string, toolInput: unknown): Promise<unknown> {
    if (callStack.includes(toolId)) {
      throw new Error(`callTool cycle detected: ${[...callStack, toolId].join(' -> ')}`)
    }
    if (callStack.length >= MAX_CALL_DEPTH) {
      throw new Error(`callTool max depth (${MAX_CALL_DEPTH}) exceeded`)
    }
    return deps.invokeTool(toolId, toolInput)
  }

  const ctx: ApiToolContext = {
    input,
    callApi,
    callTool,
    log: (...args: unknown[]) => logger.info('[api-tool]', ...args.map((a) => String(a))),
    headers: options.headers,
  }

  const globals = { ...presetLibs, ctx }

  /** Race a promise against the overall wall-clock timeout. */
  function withTimeout<T>(p: Promise<T>): Promise<T> {
    return Promise.race([
      p,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error('API tool execution timed out')), TOTAL_TIMEOUT_MS)
      ),
    ])
  }

  try {
    // Stage 1 — pre: produce request params from user code. A blank pre means
    // "no request transform" → empty params.
    const preCode = spec.pre && spec.pre.trim() ? spec.pre : 'return {}'
    const requestParams = (await withTimeout(
      runInSandbox(preCode, { scope: { input }, globals })
    )) as ApiCallParams

    // Overlay the caller's forwarded inbound headers onto the outbound call.
    // Forwarded headers are the base; headers the pre code set explicitly win,
    // so the tool author can override them. Applied to requestParams so both the
    // forwardIdentity and plain branches below inherit them.
    const outboundParams: ApiCallParams =
      options.headers && Object.keys(options.headers).length > 0
        ? { ...(requestParams ?? {}), headers: { ...options.headers, ...(requestParams?.headers ?? {}) } }
        : (requestParams ?? {})

    // Stage 2 — request: call the primary connection.
    let response: ApiCallResult
    try {
      // When forwardIdentity is requested, resolve the connection up-front so
      // we can determine the HTTP method (method-aware injection) and apply
      // the fail-closed guard before any network I/O takes place.
      if (options.forwardIdentity) {
        if (!options.identity) {
          return {
            success: false,
            stage: 'request',
            error: 'forwardIdentity identity unresolved (fail-closed)',
          }
        }
        const resolved = await deps.resolveConnection(spec.request.connectionId)
        if (!resolved) throw new Error(`connection not found: ${spec.request.connectionId}`)
        if (resolved.type !== 'custom_api') {
          throw new Error(
            `connection ${spec.request.connectionId} is not custom_api (got ${resolved.type})`
          )
        }
        const effectiveParams: ApiCallParams = { ...outboundParams }
        const method = ((resolved.config as ConnectionConfig).httpMethod ?? 'GET').toUpperCase()
        if (method === 'GET' || method === 'HEAD' || method === 'DELETE') {
          effectiveParams.headers = {
            ...(effectiveParams.headers ?? {}),
            'X-Identity': JSON.stringify(options.identity),
          }
        } else {
          const base =
            effectiveParams.body && typeof effectiveParams.body === 'object'
              ? (effectiveParams.body as Record<string, unknown>)
              : {}
          effectiveParams.body = { ...base, identity: options.identity }
        }
        response = await withTimeout(
          callCustomApi(resolved.config as ConnectionConfig, effectiveParams)
        )
      } else {
        response = await withTimeout(callApi(spec.request.connectionId, outboundParams))
      }
    } catch (err) {
      return { success: false, stage: 'request', error: errMsg(err) }
    }

    // Stage 3 — post: transform the response into the tool's output. A blank post
    // means "no response transform" → return the raw response body as-is.
    const postCode = spec.post && spec.post.trim() ? spec.post : 'return scope.response.body'
    const output = await withTimeout(
      runInSandbox(postCode, { scope: { input, response }, globals })
    )
    return { success: true, result: output }
  } catch (err) {
    return { success: false, error: errMsg(err) }
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
