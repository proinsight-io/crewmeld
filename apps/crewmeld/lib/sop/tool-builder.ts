/**
 * Build OpenAI tool definitions from DB tool_instances table — for SOP node LLM multi-tool execution
 *
 * toolIds now store instance IDs (not template IDs).
 * Query endpoints from tool_instances table, get parameter schemas from tools table.
 */

import { db, toolInstances, tools as toolsTable } from '@crewmeld/db'
import { createLogger } from '@crewmeld/logger'
import { inArray } from 'drizzle-orm'
import type { SkillPackage } from '@/app/(employee)/skills/types'
import type { OpenAITool } from '@/lib/conversation/types'
import { t } from '@/lib/core/server-i18n'

const logger = createLogger('SopToolBuilder')

/** Compose tool description: base description + API doc (for LLM to understand parameter format) */
function buildToolDescription(
  description: string | undefined | null,
  apiDoc: string | undefined | null,
  fallbackName: string
): string {
  const base = description || t('sopCallTool', undefined, { name: fallbackName })
  if (!apiDoc) return base
  return `${base}\n\n${apiDoc}`
}

interface ToolParameters {
  type: string
  properties: Record<string, { type: string; description: string }>
  required?: string[]
}

export interface ToolEndpointInfo {
  /** Instance id — primary identifier for logs and bookkeeping. */
  toolId: string
  /**
   * Template id — used by script-type tools to locate code on NFS at
   * `paths.toolCode.forBff(templateId)`. Populated for every endpoint
   * regardless of deploy type so downstream callers don't have to re-query.
   */
  templateId: string
  endpoint: string
  instanceName: string
  /**
   * When true, the `endpoint` is a placeholder string: the caller must
   * call {@link materializeMountedTools} to deploy a per-execution Pod
   * and overwrite the endpoint before any tool call is dispatched.
   */
  needsFileMount?: boolean
  /**
   * Skill package required to deploy a per-execution Pod when
   * needsFileMount is set. Only populated for mounted tools.
   */
  skill?: SkillPackage
  /** Whether the endpoint goes through OpenSandbox proxy (needs OPEN-SANDBOX-API-KEY header) */
  useProxy?: boolean
  /** Deploy type — when 'opensandbox-script', tool calls use ephemeral containers instead of HTTP. */
  deployType?: 'k8s' | 'opensandbox' | 'opensandbox-script'
  /**
   * Instance-level env vars (secret/connection params). Merged with manifest
   * defaults inside the invoker when running script-type tools.
   */
  envVars?: Array<{ name: string; value: string }>
}

export interface BuildToolResult {
  tools: OpenAITool[]
  endpointMap: Map<string, ToolEndpointInfo>
}

/**
 * Build OpenAI tool definitions and endpoint mapping from instance ID list
 *
 * Only includes instances with deploy.status === 'deployed'
 */
export async function buildToolDefinitionsFromIds(instanceIds: string[]): Promise<BuildToolResult> {
  const tools: OpenAITool[] = []
  const endpointMap = new Map<string, ToolEndpointInfo>()

  if (instanceIds.length === 0) {
    return { tools, endpointMap }
  }

  // Query instance info. presetParams / envVars are pulled too so the
  // per-execution mount-deploy path can use instance-level overrides
  // without an extra round-trip; they're ignored for the non-mount path.
  const instanceRows = await db
    .select({
      id: toolInstances.id,
      templateId: toolInstances.templateId,
      name: toolInstances.name,
      deploy: toolInstances.deploy,
      presetParams: toolInstances.presetParams,
      envVars: toolInstances.envVars,
    })
    .from(toolInstances)
    .where(inArray(toolInstances.id, instanceIds))

  // Batch query parameter schemas for all related templates. Pull the
  // mount flag + code / preset / env so per-execution deploy can happen
  // without a second round-trip when materializeMountedTools fires.
  const templateIds = [...new Set(instanceRows.map((r) => r.templateId))]
  const templateRows =
    templateIds.length > 0
      ? await db
          .select({
            id: toolsTable.id,
            name: toolsTable.name,
            description: toolsTable.description,
            parameters: toolsTable.parameters,
            apiDoc: toolsTable.apiDoc,
            code: toolsTable.code,
            presetParams: toolsTable.presetParams,
            language: toolsTable.language,
            envVars: toolsTable.envVars,
            needsFileMount: toolsTable.needsFileMount,
          })
          .from(toolsTable)
          .where(inArray(toolsTable.id, templateIds))
      : []

  const templateMap = new Map(templateRows.map((r) => [r.id, r]))

  // Instance-level presetParams + envVars override the template values
  // when present — same precedence the warm-pool / standard deploy uses.
  const instanceExtraMap = new Map(
    instanceRows.map((r) => [
      r.id,
      {
        presetParams: r.presetParams as Record<string, string> | null,
        envVars: r.envVars as Array<{ name: string; value: string }> | null,
      },
    ])
  )

  for (const row of instanceRows) {
    const deploy = row.deploy as { status?: string; endpoint?: string; deployType?: string; useProxy?: boolean } | null
    const template = templateMap.get(row.templateId)
    const needsFileMount = template?.needsFileMount === true
    const isScript = deploy?.deployType === 'opensandbox-script'

    // Script-type tools have no endpoint (they use ephemeral containers).
    // Mounted tools deploy per-execution; endpoint is filled in later.
    // All others require a pre-deployed endpoint.
    if (!needsFileMount && !isScript && (deploy?.status !== 'deployed' || !deploy.endpoint)) {
      logger.warn(`Instance ${row.id} (${row.name}) not deployed or missing endpoint, skipping`)
      continue
    }
    if (isScript && deploy?.status !== 'deployed') {
      logger.warn(`Script instance ${row.id} (${row.name}) not deployed, skipping`)
      continue
    }

    const instanceExtraEarly = instanceExtraMap.get(row.id)
    const toolName = `skill_${row.id}`
    const endpointInfo: ToolEndpointInfo = {
      toolId: row.id,
      templateId: row.templateId,
      endpoint: deploy?.endpoint ?? '',
      instanceName: row.name,
      useProxy: deploy?.useProxy ?? false,
      deployType: deploy?.deployType as ToolEndpointInfo['deployType'],
      ...(isScript
        ? {
            envVars:
              instanceExtraEarly?.envVars ??
              (template?.envVars as Array<{ name: string; value: string }> | null) ??
              undefined,
          }
        : {}),
    }
    if (needsFileMount && template) {
      const instanceExtra = instanceExtraMap.get(row.id)
      const presetParams =
        instanceExtra?.presetParams ??
        (template.presetParams as Record<string, string> | null) ??
        undefined
      const envVars =
        instanceExtra?.envVars ??
        (template.envVars as Array<{ name: string; value: string }> | null) ??
        undefined
      endpointInfo.needsFileMount = true
      endpointInfo.skill = {
        id: row.templateId,
        name: template.name,
        description: template.description,
        version: '',
        size: '',
        uploadedAt: '',
        source: 'installed',
        code: template.code ?? undefined,
        parameters: template.parameters as SkillPackage['parameters'],
        presetParams,
        envVars,
        language: (template.language as SkillPackage['language']) ?? 'javascript',
        needsFileMount: true,
      }
    }
    endpointMap.set(toolName, endpointInfo)

    const skillParams = template?.parameters as ToolParameters | null

    const parameters: Record<string, unknown> = skillParams
      ? {
          type: skillParams.type || 'object',
          properties: skillParams.properties ?? {},
          ...(skillParams.required ? { required: skillParams.required } : {}),
        }
      : {
          type: 'object',
          description: t('sopToolInput'),
          additionalProperties: true,
        }

    tools.push({
      type: 'function',
      function: {
        name: toolName,
        description: buildToolDescription(template?.description, template?.apiDoc, row.name),
        parameters: parameters as OpenAITool['function']['parameters'],
      },
    })
  }

  logger.info(`Built ${tools.length} tool definitions from ${instanceIds.length} instance IDs`)
  return { tools, endpointMap }
}

/**
 * Ensure every mounted tool referenced by `endpointMap` has a running
 * Pod, and fill in its endpoint. In the B1 shared-mount model the Pod is
 * **long-lived per tool instance** — one deploy/redeploy serves every
 * SOP execution that routes here. So if `info.endpoint` is already a
 * usable URL (tool was previously deployed and its instance row still
 * has the endpoint), this is a no-op for that tool.
 *
 * For tools whose endpoint is empty (first SOP touching them, or the
 * instance got undeployed), this triggers a fresh `deploySkill()`,
 * persists the new endpoint to `tool_instances.deploy`, and overwrites
 * the placeholder in the endpoint map.
 *
 * Returns the list of (toolName, skillId, instanceId) deployed in this
 * call. With B1 these Pods are intentionally NOT torn down by the
 * caller — they persist to serve future SOP executions. The list is
 * returned for logging/observability only.
 */
export async function materializeMountedTools(
  endpointMap: Map<string, ToolEndpointInfo>,
  sopExecutionId: string
): Promise<Array<{ toolName: string; skillId: string; instanceId: string }>> {
  const deployed: Array<{ toolName: string; skillId: string; instanceId: string }> = []
  let k8sModule: typeof import('@/lib/k8s/deploy-skill') | null = null
  let dbModule: typeof import('@crewmeld/db') | null = null

  for (const [toolName, info] of endpointMap) {
    if (!info.needsFileMount || !info.skill) continue
    // Script-type tools never run a persistent Pod even when "deployed" via
    // the skills UI — adopt only syncs code to NFS. Each call spins up an
    // ephemeral sandbox in invokeScriptTool (lib/tools/script-invoker.ts),
    // which mounts /root/io and destroys the sandbox in `finally`. The SOP
    // node executor branches on info.deployType === 'opensandbox-script'
    // (lib/sop/llm-tool-executor.ts:314), so no pre-deploy work is needed
    // and we must not try to fill an endpoint that doesn't exist.
    if (info.deployType === 'opensandbox-script') continue
    if (info.endpoint) {
      // Pod already exists; nothing to do.
      continue
    }
    logger.info(
      `Mounted tool ${toolName} has no endpoint; deploying shared instance Pod`,
      { sopExecutionId, skillId: info.skill.id, instanceId: info.toolId }
    )
    if (!k8sModule) k8sModule = await import('@/lib/k8s/deploy-skill')
    if (!dbModule) dbModule = await import('@crewmeld/db')

    // Use the instance id as the K8s resource name (matches what the
    // skills UI uses when deploying via the "Deploy" button), so the
    // Pod is shared across all SOPs referencing this instance.
    const skillForDeploy = { ...info.skill, id: info.toolId }
    const result = await k8sModule.deploySkill(skillForDeploy)
    if (result.deployType === 'opensandbox-script') {
      logger.warn('Mounted tools cannot use opensandbox-script deploy type', { toolName })
      continue
    }
    info.endpoint = result.endpoint

    // Persist the deploy state to the instance row so subsequent
    // SOP triggers see the existing endpoint without re-deploying.
    try {
      const { eq } = await import('drizzle-orm')
      const { toolInstances } = await import('@crewmeld/db/schema')
      await dbModule.db
        .update(toolInstances)
        .set({
          deploy: {
            status: 'deployed',
            deployType: result.deployType,
            endpoint: result.endpoint,
            nodePort: result.nodePort,
            deployedAt: new Date().toISOString(),
          },
          updatedAt: new Date(),
        })
        .where(eq(toolInstances.id, info.toolId))
    } catch (e) {
      logger.warn('Failed to persist deploy state for mounted instance', {
        instanceId: info.toolId,
        error: e instanceof Error ? e.message : String(e),
      })
    }

    deployed.push({ toolName, skillId: info.skill.id, instanceId: info.toolId })
  }

  return deployed
}

/**
 * In the B1 shared-mount model, mounted-tool Pods are long-lived and
 * **not** torn down at SOP completion. This function is kept for API
 * compatibility with the SOP node executor's `finally` block, but it's
 * intentionally a no-op now.
 *
 * Manual cleanup (e.g. when retiring a tool instance) goes through the
 * existing "Undeploy" button in the skills UI, which calls
 * {@link import('@/lib/k8s/deploy-skill').undeploySkill}.
 */
export async function cleanupMountedTools(
  _deployed: Array<{ toolName: string; skillId: string; instanceId: string }>,
  _sopExecutionId: string
): Promise<void> {
  // No-op by design (B1 shared-mount).
}
