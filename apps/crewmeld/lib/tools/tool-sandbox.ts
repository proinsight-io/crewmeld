/**
 * Shared ephemeral-sandbox preparation for invoking adopted dev-studio tools.
 *
 * Both script and service tools mount the SAME way: read the manifest from
 * NFS, create an OpenSandbox container with the tool code + shared
 * site-packages + per-exec IO dir mounted, apply the egress network policy,
 * and wait until it is running. The ONLY difference between the two kinds is
 * how the result is pulled out of the running container:
 *   - script  (see {@link invokeScriptTool}):  stdin → run start.sh → stdout
 *   - service (see {@link invokeServiceTool}):  background start.sh → wait for
 *                                               port → HTTP call → response
 * The create/teardown lifecycle is identical, so it lives here and both
 * invokers share it. Refs spec 2026-05-28 §11.1.
 */

import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createLogger } from '@crewmeld/logger'
import { isAsyncToolsEnabled } from '@/lib/core/config/feature-flags'
import { generateExecutionId } from '@/lib/core/execution-id'
import type { ManifestT } from '@/lib/dev-studio/manifest-reader'
import { readManifestFromTool } from '@/lib/dev-studio/manifest-reader'
import { applyManifestDefaults, DEFAULT_IMAGE } from '@/lib/dev-studio/package-defaults'
import { buildToolNetworkPolicy } from '@/lib/dev-studio/network-policy-builder'
import type { OpenSandboxClient } from '@/lib/dev-studio/opensandbox-client'
import { getOpenSandboxClient } from '@/lib/dev-studio/opensandbox-client'
import { paths } from '@/lib/dev-studio/paths'
import { getSandboxSettings } from '@/lib/sandbox/settings'

const logger = createLogger('ToolSandbox')

/** How long the ephemeral test/invoke sandbox stays alive (sleep entrypoint). */
export const TOOL_SANDBOX_TIMEOUT_SECONDS = 300

export interface PrepareToolSandboxArgs {
  /** Template id used as the on-disk tool identifier under `tools-workspace/`. */
  toolId: string
  /** Caller-supplied input payload — merged with per-invocation metadata. */
  input: unknown
  /** Environment variables resolved by the caller (instance/connection/etc.). */
  userEnv: Record<string, string>
  /** Optional pre-allocated execution id (keeps the io path consistent with a DB row). */
  execId?: string
  /** Caller's forwardable inbound HTTP headers, injected as `_headers`. */
  headers?: Record<string, string>
  /** Value for the `crewmeld.purpose` sandbox metadata label. */
  purpose: string
}

export interface PreparedToolSandbox {
  client: OpenSandboxClient
  sandboxId: string
  manifest: ManifestT
  /** Manifest with image/resource defaults applied. */
  withDefaults: ManifestT
  execId: string
  /**
   * The request payload: caller input merged with the per-invocation
   * SOP/file/call metadata. Script tools pipe this on stdin; service tools
   * send it as the HTTP request body.
   */
  payload: Record<string, unknown>
  /** Tear down the ephemeral sandbox (best-effort, never throws). */
  destroy: () => Promise<void>
}

/**
 * Create and start the ephemeral OpenSandbox container shared by script and
 * service tool invocation.
 *
 * @throws when the manifest or start.sh is missing, or sandbox creation /
 *   readiness fails. On a readiness failure the partially-created sandbox is
 *   destroyed before the error propagates.
 */
export async function prepareToolSandbox(
  args: PrepareToolSandboxArgs
): Promise<PreparedToolSandbox> {
  const { toolId, input, userEnv, headers, purpose } = args
  const execId = args.execId ?? generateExecutionId('inv')

  const manifest = await readManifestFromTool(toolId)
  if (!manifest) {
    throw new Error(
      `Manifest not found for tool ${toolId} (expected on NFS under tool code dir).`
    )
  }
  const withDefaults = applyManifestDefaults(manifest)

  const codeDir = paths.toolCode.forBff(toolId)
  try {
    await fs.access(path.join(codeDir, 'start.sh'))
  } catch {
    throw new Error(
      `start.sh not found in tool code dir ${codeDir}. Run adopt to sync the workspace.`
    )
  }

  // Per-invocation IO scoping: the sandbox mounts the sop-files ROOT at
  // /root/io and the tool navigates to its scoped subdir via `_sopFileDir`
  // injected into the request payload.
  const inputObj = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const sopExecId =
    typeof inputObj._sopExecutionId === 'string' && inputObj._sopExecutionId.length > 0
      ? inputObj._sopExecutionId
      : execId
  const payload: Record<string, unknown> = {
    ...inputObj,
    _sopExecutionId: sopExecId,
    _sopFileDir: paths.sopFiles.relPath(sopExecId),
    _callId: `call_${randomUUID().slice(0, 12)}`,
    ...(headers ? { _headers: headers } : {}),
  }

  const sopFilesDirBff = paths.sopFiles.forBff(sopExecId)
  await fs.mkdir(sopFilesDirBff, { recursive: true })

  // Manifest env defaults first, then caller-resolved env wins.
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
    // gunicorn, etc.) land in `/shared/site-packages/bin`; without this prefix
    // start.sh can't find them. Matches sandbox-loader.ts's run-test env.
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
  // global allow-lists ∪ system egress.
  // In async-tools mode the pod POSTs its result back to the BFF callback URL,
  // so the callback host must be reachable. In allowlist egress mode that means
  // allow-listing it (no-op in unrestricted mode, which ignores the lists).
  const callbackEgress: string[] = []
  if (isAsyncToolsEnabled()) {
    try {
      const { getSandboxCallbackBaseUrl } = await import('@/lib/core/utils/urls')
      const host = new URL(getSandboxCallbackBaseUrl()).hostname
      if (host) callbackEgress.push(host)
    } catch (e) {
      logger.warn('Failed to resolve callback host for egress allow-list', {
        error: e instanceof Error ? e.message : String(e),
      })
    }
  }

  const sandboxSettings = await getSandboxSettings()
  const networkPolicy = buildToolNetworkPolicy(
    sandboxSettings.egressMode,
    manifest.dependencies.domains,
    {
      globalDomains: sandboxSettings.allowedDomains,
      globalIps: [...sandboxSettings.allowedIps, ...callbackEgress],
      toolIps: manifest.dependencies.ips,
    }
  )

  const client = getOpenSandboxClient()
  const sandbox = await client.createSandbox({
    image,
    entrypoint: ['sleep', String(TOOL_SANDBOX_TIMEOUT_SECONDS)],
    resourceLimits,
    timeoutSeconds: TOOL_SANDBOX_TIMEOUT_SECONDS,
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
        name: 'sop-files',
        hostPath: paths.sopFiles.forSandbox(),
        mountPath: '/root/io',
        readOnly: false,
      },
    ],
    networkPolicy,
    metadata: { 'crewmeld.purpose': purpose, 'crewmeld.exec-id': execId },
  })
  const sandboxId = sandbox.id

  const destroy = async (): Promise<void> => {
    await client.destroy(sandboxId).catch((err) => {
      logger.warn('Failed to destroy ephemeral tool sandbox', { sandboxId, error: err })
    })
  }

  try {
    await client.waitUntilRunning(sandboxId, { timeoutMs: 30_000, intervalMs: 300 })
  } catch (err) {
    await destroy()
    throw err
  }

  return { client, sandboxId, manifest, withDefaults, execId, payload, destroy }
}
