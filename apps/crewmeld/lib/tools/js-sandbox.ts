import vm from 'node:vm'

export interface RunInSandboxOptions {
  /** Variables/functions exposed to user code under `scope`. */
  scope: Record<string, unknown>
  /** Extra whitelisted globals merged into the context (e.g. preset libs). */
  globals?: Record<string, unknown>
  /** Synchronous-execution timeout guard (ms). Default 5000. */
  timeoutMs?: number
}

/**
 * Run a user-provided JS snippet in a node:vm context with a minimal whitelist.
 * The snippet body is wrapped in an async function so it may `await` injected
 * async functions (e.g. ctx.callApi) and must `return` its result.
 *
 * Note: vm `timeout` only interrupts synchronous code. Callers that await async
 * host functions must additionally bound total wall-clock at a higher layer.
 */
export async function runInSandbox<T = unknown>(
  code: string,
  options: RunInSandboxOptions
): Promise<T> {
  const { scope, globals = {}, timeoutMs = 5000 } = options

  const sandbox: Record<string, unknown> = {
    scope,
    JSON,
    Math,
    Date,
    Array,
    Object,
    String,
    Number,
    Boolean,
    RegExp,
    Map,
    Set,
    Promise,
    Error,
    encodeURIComponent,
    decodeURIComponent,
    ...globals,
  }

  const context = vm.createContext(sandbox, {
    codeGeneration: { strings: false, wasm: false },
  })

  const wrapped = `(async () => { ${code}\n })()`
  const script = new vm.Script(wrapped)
  // timeout guards the synchronous portion (e.g. while(true)). The returned
  // promise resolves with the async result.
  const result = script.runInContext(context, { timeout: timeoutMs }) as Promise<T>
  return await result
}
