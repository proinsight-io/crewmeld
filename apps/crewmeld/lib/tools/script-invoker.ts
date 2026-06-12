/**
 * Ephemeral container invoker for script-type dev-studio tools.
 *
 * Delegates the create/mount/teardown lifecycle to {@link prepareToolSandbox}
 * (shared with the service invoker), then runs the script one-shot: pipe the
 * input payload on stdin via `bash start.sh`, capture the last stdout line as
 * the JSON result, and destroy the sandbox.
 *
 * The service counterpart ({@link invokeServiceTool}) shares the same sandbox
 * setup but launches start.sh as a background server and reaches it over HTTP —
 * see service-invoker.ts. Refs spec 2026-05-28 §11.1.
 */

import { createLogger } from '@crewmeld/logger'
import { prepareToolSandbox } from './tool-sandbox'

const logger = createLogger('ScriptInvoker')

const SCRIPT_EXEC_TIMEOUT_MS = 60_000

export interface ScriptInvokeArgs {
  /** Template id used as the on-disk tool identifier under `tools-workspace/`. */
  toolId: string
  /** Caller-supplied input payload — serialized to JSON and piped on stdin. */
  input: unknown
  /** Extra environment variables resolved from the instance row (envVars). */
  userEnv: Record<string, string>
  /**
   * Optional pre-allocated execution id. When the calling route has already
   * persisted a `tool_executions` row (for IO authorization downstream), pass
   * the same id so the io path is consistent with the DB row.
   */
  execId?: string
  /**
   * Caller's inbound HTTP headers (already filtered to the forwardable subset
   * by the invoke route). Injected into the container stdin as `_headers` so
   * tool code can read them via `input["_headers"]`.
   */
  headers?: Record<string, string>
}

export interface ScriptInvokeResult {
  success: boolean
  result?: unknown
  error?: string
  executionTime: number
}

export async function invokeScriptTool(args: ScriptInvokeArgs): Promise<ScriptInvokeResult> {
  const start = Date.now()

  let prepared: Awaited<ReturnType<typeof prepareToolSandbox>>
  try {
    prepared = await prepareToolSandbox({ ...args, purpose: 'script-invoke' })
  } catch (e) {
    return {
      success: false,
      error: e instanceof Error ? e.message : String(e),
      executionTime: Date.now() - start,
    }
  }

  const { client, sandboxId, payload, destroy } = prepared
  try {
    const execResult = await client.exec({
      sandboxId,
      // cd into the code dir first so start.sh's relative paths (e.g.
      // `python3 main.py`) resolve — matches the run-test path's cwd contract.
      cmd: ['bash', '-c', 'cd /root/workspace && bash start.sh'],
      stdin: JSON.stringify(payload),
      timeoutMs: SCRIPT_EXEC_TIMEOUT_MS,
    })

    if (execResult.exitCode !== 0) {
      logger.warn('Script tool exited with non-zero code', {
        sandboxId,
        exitCode: execResult.exitCode,
        stderr: execResult.stderr.slice(0, 500),
      })
      return {
        success: false,
        error: execResult.stderr || execResult.stdout || `exit code ${execResult.exitCode}`,
        executionTime: Date.now() - start,
      }
    }

    // Parse the last non-empty stdout line as JSON (tools may log progress to
    // stdout before emitting the final result).
    let parsed: unknown
    const lines = execResult.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
    const lastLine = lines.length > 0 ? lines[lines.length - 1] : ''
    try {
      parsed = JSON.parse(lastLine)
    } catch {
      parsed = { raw: execResult.stdout }
    }

    return { success: true, result: parsed, executionTime: Date.now() - start }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    logger.error('Script tool invocation failed', { sandboxId, error: msg })
    return { success: false, error: msg, executionTime: Date.now() - start }
  } finally {
    await destroy()
  }
}
