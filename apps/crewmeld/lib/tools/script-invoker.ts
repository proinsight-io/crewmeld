/**
 * Ephemeral container invoker for script-type dev-studio tools.
 *
 * Each call:
 *   1. Generates a fresh execId via `generateExecutionId('inv')` so the
 *      per-invocation IO directory (`/root/io`) is unique on NFS.
 *   2. Reads the tool's manifest from NFS (`paths.toolCode.forBff(toolId)`)
 *      to recover image + egress + resource limits.
 *   3. Creates an OpenSandbox container with NFS volumes mounted in:
 *        - shared site-packages (RO) → /shared/site-packages
 *        - tool code               (RO) → /root/workspace
 *        - per-exec IO dir        (RW) → /root/io
 *      with `PYTHONPATH=/shared/site-packages` so prewarmed deps are visible.
 *   4. Execs `bash /root/workspace/start.sh` feeding the user input as stdin.
 *   5. Parses the last non-empty stdout line as JSON; falls back to
 *      `{ raw: stdout }`.
 *   6. Destroys the sandbox (best-effort).
 *
 * Replaces the previous snapshot-based flow (deploy → createSnapshot → invoke
 * createSandbox({ snapshotId }))). Refs spec 2026-05-28 §11.1.
 */

import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createLogger } from '@crewmeld/logger'
import { generateExecutionId } from '@/lib/core/execution-id'
import { applyManifestDefaults, DEFAULT_IMAGE } from '@/lib/dev-studio/package-defaults'
import { readManifestFromTool } from '@/lib/dev-studio/manifest-reader'
import { buildToolNetworkPolicy } from '@/lib/dev-studio/network-policy-builder'
import { getSandboxSettings } from '@/lib/sandbox/settings'
import { paths } from '@/lib/dev-studio/paths'

const logger = createLogger('ScriptInvoker')

const SCRIPT_SANDBOX_TIMEOUT_SECONDS = 300
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
   * persisted a `tool_executions` row (for IO authorization downstream),
   * pass the same id so the io path is consistent with the DB row.
   * If omitted, the invoker generates its own id (no DB row written here).
   */
  execId?: string
}

export interface ScriptInvokeResult {
  success: boolean
  result?: unknown
  error?: string
  executionTime: number
}

export async function invokeScriptTool(args: ScriptInvokeArgs): Promise<ScriptInvokeResult> {
  const { toolId, input, userEnv } = args
  const start = Date.now()
  const execId = args.execId ?? generateExecutionId('inv')

  const manifest = await readManifestFromTool(toolId)
  if (!manifest) {
    return {
      success: false,
      error: `Manifest not found for tool ${toolId} (expected on NFS under tool code dir).`,
      executionTime: Date.now() - start,
    }
  }
  const withDefaults = applyManifestDefaults(manifest)

  const codeDir = paths.toolCode.forBff(toolId)
  try {
    await fs.access(path.join(codeDir, 'start.sh'))
  } catch {
    return {
      success: false,
      error: `start.sh not found in tool code dir ${codeDir}. Run adopt to sync the workspace.`,
      executionTime: Date.now() - start,
    }
  }

  // The sandbox mounts the sop-files **root** at /root/io; the tool
  // navigates to its scoped subdir via `_sopFileDir` injected into stdin
  // (see lib/sop/llm-tool-executor.ts for the production injection path
  // and sandbox-loader.ts for the dev-studio test path). The sopExecId
  // comes from the request input — if the caller (intent-router or test
  // harness) didn't inject one we synthesize from the execId so the
  // contract still works end-to-end. `_sopExecutionId` is preserved for
  // logging / output-file naming; `_sopFileDir` is what tool code joins
  // into the file path.
  const inputObj = (input && typeof input === 'object' ? (input as Record<string, unknown>) : {})
  const sopExecId =
    typeof inputObj._sopExecutionId === 'string' && inputObj._sopExecutionId.length > 0
      ? inputObj._sopExecutionId
      : execId
  const stdinPayload = {
    ...inputObj,
    _sopExecutionId: sopExecId,
    _sopFileDir: paths.sopFiles.relPath(sopExecId),
    // Unique per invocation. AI tools may use it to prefix output
    // filenames when explicit uniqueness matters; BFF (llm-tool-executor)
    // also auto-handles same-SOP filename collisions with (N) suffix.
    _callId: `call_${randomUUID().slice(0, 12)}`,
  }
  const sopFilesDirBff = paths.sopFiles.forBff(sopExecId)
  try {
    await fs.mkdir(sopFilesDirBff, { recursive: true })
  } catch (e) {
    return {
      success: false,
      error: `Failed to create sop-files dir ${sopFilesDirBff}: ${
        e instanceof Error ? e.message : String(e)
      }`,
      executionTime: Date.now() - start,
    }
  }

  // Build manifest defaults for env, then layer instance-supplied vars on top.
  const manifestEnv: Record<string, string> = {}
  if (manifest.env?.properties) {
    for (const [k, prop] of Object.entries(manifest.env.properties)) {
      if (prop.default !== undefined && prop.default !== null) {
        manifestEnv[k] = String(prop.default)
      }
    }
  }
  const sandboxEnv: Record<string, string> = {
    ...manifestEnv,
    ...userEnv,
    PYTHONPATH: '/shared/site-packages',
    // Binaries from `pip install --target /shared/site-packages` (uvicorn,
    // gunicorn, pytest, etc.) land in `/shared/site-packages/bin`; without
    // this prefix they're invisible to start.sh and the tool fails with
    // "<bin>: not found". Matches sandbox-loader.ts's run-test env.
    PATH: '/shared/site-packages/bin:/usr/local/bin:/usr/bin:/bin',
  }

  const image = withDefaults.image ?? DEFAULT_IMAGE
  const resourceLimits = withDefaults.resources?.limits ?? {
    cpu: '500m',
    memory: '512Mi',
    'ephemeral-storage': '1Gi',
  }
  // Network policy follows the admin global egress mode (Model A): unrestricted
  // → reach anything; allowlist → deny-default with manifest domains ∪ admin
  // global allow-lists ∪ CREWMELD_SANDBOX_SYSTEM_EGRESS.
  const sandboxSettings = await getSandboxSettings()
  const networkPolicy = buildToolNetworkPolicy(
    sandboxSettings.egressMode,
    manifest.dependencies.domains,
    {
      globalDomains: sandboxSettings.allowedDomains,
      globalIps: sandboxSettings.allowedIps,
      toolIps: manifest.dependencies.ips,
    }
  )

  const { getOpenSandboxClient } = await import('@/lib/dev-studio/opensandbox-client')
  const client = getOpenSandboxClient()

  let sandboxId: string | undefined
  try {
    const sandbox = await client.createSandbox({
      image,
      entrypoint: ['sleep', String(SCRIPT_SANDBOX_TIMEOUT_SECONDS)],
      resourceLimits,
      timeoutSeconds: SCRIPT_SANDBOX_TIMEOUT_SECONDS,
      env: sandboxEnv,
      volumes: [
        {
          name: 'shared-libs',
          hostPath: paths.sharedLibs.forSandbox(),
          mountPath: '/shared/site-packages',
          readOnly: true,
        },
        {
          name: 'tool-code',
          hostPath: paths.toolCode.forSandbox(toolId),
          mountPath: '/root/workspace',
          readOnly: false,
        },
        {
          // Sop-files ROOT — tool navigates to /root/io/<_sopExecutionId>/<file>
          // using the id injected into its stdin JSON above.
          name: 'sop-files',
          hostPath: paths.sopFiles.forSandbox(),
          mountPath: '/root/io',
          readOnly: false,
        },
      ],
      networkPolicy,
      metadata: { 'crewmeld.purpose': 'script-invoke', 'crewmeld.exec-id': execId },
    })
    sandboxId = sandbox.id
    await client.waitUntilRunning(sandboxId, { timeoutMs: 30_000, intervalMs: 300 })

    const execResult = await client.exec({
      sandboxId,
      // cd into the code dir first so start.sh's relative paths (e.g.
      // `python3 main.py`) resolve — matches the run-test path's cwd contract.
      cmd: ['bash', '-c', 'cd /root/workspace && bash start.sh'],
      stdin: JSON.stringify(stdinPayload),
      timeoutMs: SCRIPT_EXEC_TIMEOUT_MS,
    })

    if (execResult.exitCode !== 0) {
      logger.warn('Script tool exited with non-zero code', {
        execId,
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
    logger.error('Script tool invocation failed', { execId, error: msg })
    return { success: false, error: msg, executionTime: Date.now() - start }
  } finally {
    if (sandboxId) {
      await client.destroy(sandboxId).catch((err) => {
        logger.warn('Failed to destroy ephemeral script sandbox', { sandboxId, error: err })
      })
    }
  }
}
