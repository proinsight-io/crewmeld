import type { ConnectionConfig } from '@/lib/connectors/types'

/** Stored in tools.api_spec when kind='api'. */
export interface ApiToolSpec {
  /** JS source: handler(input, ctx) => requestParams. Must `return`. */
  pre: string
  /** Primary call config. */
  request: {
    /** Default custom_api connection id; pre may override per-call via ctx. */
    connectionId: string
  }
  /** JS source: handler(response, ctx) => output. Must `return`. */
  post: string
}

/** One connection the tool depends on, emitted in the .cmtool manifest (no secrets). */
export interface ApiToolConnectionRequirement {
  /** connectionId as referenced inside apiSpec at export time. */
  ref: string
  /** Display name for human matching during import. */
  name: string
  type: 'custom_api'
}

/** Result of one custom_api call exposed to user code. */
export interface ApiCallResult {
  status: number
  statusText: string
  headers: Record<string, string>
  /** Parsed JSON when response is JSON, else raw text. */
  body: unknown
}

/** Per-call runtime overrides user code may pass to ctx.callApi. */
export interface ApiCallParams {
  query?: Record<string, string>
  headers?: Record<string, string>
  body?: unknown
  pathParams?: Record<string, string>
}

/** Sandbox context handed to pre/post code. */
export interface ApiToolContext {
  input: unknown
  callApi: (connectionId: string, params?: ApiCallParams) => Promise<ApiCallResult>
  callTool: (toolId: string, input: unknown) => Promise<unknown>
  log: (...args: unknown[]) => void
  /**
   * Caller's inbound HTTP headers (filtered to the forwardable subset by the
   * invoke route). Read access for pre/post code; the runner also overlays
   * these onto the outbound call's headers (pre-set headers win). Present only
   * for HTTP-invoked tools.
   */
  headers?: Record<string, string>
}

/** Dependencies injected into runApiTool (allows mocking in tests). */
export interface ApiToolRunnerDeps {
  resolveConnection: (
    connectionId: string
  ) => Promise<{ type: string; config: ConnectionConfig } | null>
  invokeTool: (toolId: string, input: unknown) => Promise<unknown>
  /** Loads apiSpec for a referenced tool id (used by callTool). */
  loadApiSpec?: (toolId: string) => Promise<ApiToolSpec | null>
}
