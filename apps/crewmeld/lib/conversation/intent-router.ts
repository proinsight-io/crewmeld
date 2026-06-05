/**
 * Intent router — convert employee-associated SOPs + tools to LLM tool definitions
 *
 * Query logic: scan all active SOPs, find SOPs where digital employee nodes have executorId === employeeId,
 * let LLM judge which SOP best fits current needs and trigger execution.
 */

import {
  db,
  employeeSkillBindings,
  sopDefinitions,
  toolInstances,
  tools as toolsTable,
} from '@crewmeld/db'
import { createLogger } from '@crewmeld/logger'
import { eq } from 'drizzle-orm'
import { t } from '@/lib/core/server-i18n'
import type { SopNode } from '@/types/sop'
import type { OpenAITool } from './types'

const logger = createLogger('IntentRouter')

interface ToolConfigResult {
  tools: OpenAITool[]
  workflowMap: Map<string, string>
  sopMap: Map<string, string>
  /** skillToolName → { skillId, endpoint, openclawConnectionId? } */
  skillMap: Map<string, { skillId: string; endpoint: string; openclawConnectionId?: string }>
  sopInfos: SopInfo[]
}

/**
 * Build employee tool config — SOPs + skills
 *
 * No longer query employee-bound workflows, directly query which SOPs assigned this employee (executorId),
 * let LLM self-judge the most suitable SOP and trigger execution.
 */
export async function buildWorkflowToolConfigs(employeeId: string): Promise<ToolConfigResult> {
  const tools: OpenAITool[] = []
  const workflowMap = new Map<string, string>() // Reserved interface, always empty
  const sopMap = new Map<string, string>()
  const skillMap = new Map<
    string,
    { skillId: string; endpoint: string; openclawConnectionId?: string }
  >()

  // 1. Query active SOPs assigned to this employee
  const sopInfos = await querySopsByEmployee(employeeId)

  if (sopInfos.length === 0) {
    // When no SOPs, degrade to exposing employee-bound skill tools (direct conversation)
    await buildSkillTools(employeeId, tools, skillMap)
    logger.info(
      `Employee ${employeeId} not assigned to any SOP, falling back to exposing ${skillMap.size} skills`
    )
    return { tools, workflowMap, sopMap, skillMap, sopInfos: [] }
  }

  // 2. Collect all SOP-associated workflow IDs for resolving inputFormat
  const sopWorkflowIdMap = new Map<string, string[]>()
  const allSopWorkflowIds = new Set<string>()
  for (const sop of sopInfos) {
    const wfIds = getSopWorkflowIdsFromNodes(sop.nodes)
    sopWorkflowIdMap.set(sop.id, wfIds)
    for (const wfId of wfIds) {
      allSopWorkflowIds.add(wfId)
    }
  }

  // 3. Batch query workflow start_trigger inputFormat
  const inputFormatMap = await batchGetWorkflowInputFormats(allSopWorkflowIds)

  // 4. Build SOP tools
  for (const sop of sopInfos) {
    const toolName = `sop_${sop.id}`
    sopMap.set(toolName, sop.id)

    const toolDescription = sop.description
      ? sop.description
      : t('convSopToolDesc', 'zh', { name: sop.name })

    // Extract inputFormat from associated workflow start_trigger, generate specific param schema
    const sopWfIds = sopWorkflowIdMap.get(sop.id) ?? []
    const inputSchema = buildInputSchemaFromWorkflows(sopWfIds, inputFormatMap)

    tools.push({
      type: 'function',
      function: {
        name: toolName,
        description: toolDescription,
        parameters: {
          type: 'object',
          properties: {
            input: inputSchema,
          },
          required: ['input'],
        },
      },
    })
  }

  // 5. Register SOP status query tool
  if (sopMap.size > 0) {
    tools.push({
      type: 'function',
      function: {
        name: 'check_sop_status',
        description: t('convSopStatusToolDesc'),
        parameters: {
          type: 'object',
          properties: {
            execution_id: {
              type: 'string',
              description: t('convSopStatusToolParam'),
            },
          },
          required: ['execution_id'],
        },
      },
    })
  }

  // 6. Register task list query tool (available in all employee conversations)
  tools.push({
    type: 'function',
    function: {
      name: 'query_my_tasks',
      description: t('convTaskListToolDesc'),
      parameters: {
        type: 'object',
        properties: {
          filter: {
            type: 'string',
            enum: ['all', 'running', 'completed'],
            description: `all=${t('convTaskFilterAll')}, running=${t('convTaskFilterActive')}, completed=${t('convTaskFilterDone')}`,
          },
          limit: {
            type: 'number',
            description: t('convTaskLimitDesc'),
          },
        },
        required: ['filter'],
      },
    },
  })

  logger.info(`Built ${tools.length} tools (SOP ${sopMap.size}, skills ${skillMap.size})`, {
    employeeId,
  })
  return { tools, workflowMap, sopMap, skillMap, sopInfos }
}

// ── SOP query (by executorId) ────────────────────────────────────────

export interface SopInfo {
  id: string
  name: string
  description: string | null
  triggerType: string
  /** Workflow name list involved in this SOP (kept for system prompt) */
  involvedWorkflows: string[]
  /** SOP node list (internal use) */
  nodes: SopNode[]
}

/**
 * Query active SOPs assigned to this employee
 *
 * Scan all active SOP nodes, find SOPs where type === 'digital_employee' && executorId === employeeId
 */
async function querySopsByEmployee(employeeId: string): Promise<SopInfo[]> {
  const allSops = await db
    .select({
      id: sopDefinitions.id,
      name: sopDefinitions.name,
      description: sopDefinitions.description,
      triggerType: sopDefinitions.triggerType,
      nodes: sopDefinitions.nodes,
    })
    .from(sopDefinitions)
    .where(eq(sopDefinitions.isActive, true))

  const result: SopInfo[] = []

  for (const sop of allSops) {
    const nodes = (sop.nodes ?? []) as SopNode[]

    // Whether any digital employee node assigned this employee
    const hasEmployee = nodes.some(
      (node) => node.type === 'digital_employee' && node.executorId === employeeId
    )

    if (!hasEmployee) continue

    result.push({
      id: sop.id,
      name: sop.name,
      description: sop.description,
      triggerType: sop.triggerType,
      involvedWorkflows: [], // No longer need to display associated workflows
      nodes,
    })
  }

  return result
}

/**
 * Query employee-associated SOP list (for system prompt)
 */
export async function buildSopInfos(employeeId: string): Promise<SopInfo[]> {
  const result = await querySopsByEmployee(employeeId)
  logger.info(`Employee ${employeeId} associated with ${result.length} SOPs`)
  return result
}

/**
 * Extract all workflow IDs from SOP node list
 */
function getSopWorkflowIdsFromNodes(nodes: SopNode[]): string[] {
  const wfIds: string[] = []
  for (const node of nodes) {
    if (node.workflowId && !wfIds.includes(node.workflowId)) {
      wfIds.push(node.workflowId)
    }
  }
  return wfIds
}

/**
 * Get all workflow IDs referenced in SOP definition (from DB query)
 */
async function getSopWorkflowIds(sopId: string): Promise<string[]> {
  const [sop] = await db
    .select({ nodes: sopDefinitions.nodes })
    .from(sopDefinitions)
    .where(eq(sopDefinitions.id, sopId))
    .limit(1)

  if (!sop) return []
  return getSopWorkflowIdsFromNodes((sop.nodes ?? []) as SopNode[])
}

// ── inputFormat -> JSON Schema conversion ──────────────────────────────────────

interface InputFormatField {
  name?: string
  type?: string
  description?: string
  value?: unknown
}

/**
 * Batch query start_trigger inputFormat for multiple workflows.
 *
 * The workflow canvas has been removed; this helper now always returns an
 * empty map, so SOP tools fall back to the loose default input schema.
 */
async function batchGetWorkflowInputFormats(
  _workflowIds: Set<string>
): Promise<Map<string, InputFormatField[]>> {
  return new Map()
}

/** Map inputFormat type to JSON Schema type */
function mapFieldType(fieldType: string | undefined): string {
  switch (fieldType) {
    case 'number':
      return 'number'
    case 'boolean':
      return 'boolean'
    case 'object':
      return 'object'
    case 'array':
    case 'file[]':
      return 'array'
    default:
      return 'string'
  }
}

/**
 * Generate input param JSON Schema from workflow inputFormat
 *
 * If associated workflow defines specific fields, generate schema with properties;
 * otherwise fall back to loose object schema.
 */
function buildInputSchemaFromWorkflows(
  workflowIds: string[],
  inputFormatMap: Map<string, InputFormatField[]>
): Record<string, unknown> {
  // Merge inputFormat fields from all associated workflows
  const mergedFields = new Map<string, InputFormatField>()
  for (const wfId of workflowIds) {
    const fields = inputFormatMap.get(wfId)
    if (!fields) continue
    for (const field of fields) {
      const name = field.name?.trim()
      if (name && !mergedFields.has(name)) {
        mergedFields.set(name, field)
      }
    }
  }

  if (mergedFields.size === 0) {
    // No inputFormat definition, fall back to loose schema
    return {
      type: 'object',
      description: t('convTriggerParams'),
      additionalProperties: true,
    }
  }

  // Generate specific properties schema
  const properties: Record<string, Record<string, unknown>> = {}
  const required: string[] = []

  for (const [name, field] of mergedFields) {
    const prop: Record<string, unknown> = {
      type: mapFieldType(field.type),
    }
    if (field.description) {
      prop.description = field.description
    }
    properties[name] = prop
    // All inputFormat-defined fields treated as required, let LLM actively extract
    required.push(name)
  }

  return {
    type: 'object',
    description: t('convTriggerParamsAll'),
    properties,
    required,
    additionalProperties: false,
  }
}

// ── Skill tool building ──────────────────────────────────────────────────

interface ToolParameters {
  type: string
  properties: Record<string, { type: string; description: string }>
  required?: string[]
}

/**
 * Build tool definitions for employee-bound skills
 *
 * Each bound skill generates a `skill_{instanceId}` tool,
 * deployment info read from tool_instances table, param schema read from tools template table.
 */
async function buildSkillTools(
  employeeId: string,
  tools: OpenAITool[],
  skillMap: Map<
    string,
    { skillId: string; endpoint: string; openclawConnectionId?: string }
  >
): Promise<void> {
  const rows = await db
    .select({
      instanceId: employeeSkillBindings.instanceId,
      skillName: toolsTable.name,
      skillDescription: toolsTable.description,
      skillParameters: toolsTable.parameters,
      instanceDeploy: toolInstances.deploy,
      apiDoc: toolsTable.apiDoc,
      instanceConnectionId: toolInstances.connectionId,
      templateConnectorType: toolsTable.connectorType,
    })
    .from(employeeSkillBindings)
    .innerJoin(toolInstances, eq(employeeSkillBindings.instanceId, toolInstances.id))
    .innerJoin(toolsTable, eq(toolInstances.templateId, toolsTable.id))
    .where(eq(employeeSkillBindings.employeeId, employeeId))

  if (rows.length === 0) return

  for (const row of rows) {
    if (!row.instanceId) continue
    const deploy = row.instanceDeploy as { status?: string; endpoint?: string } | null
    if (deploy?.status !== 'deployed' || !deploy.endpoint) continue

    const ct = row.templateConnectorType as { type?: string } | null
    const isOpenclaw = ct?.type === 'openclaw'

    const toolName = `skill_${row.instanceId}`
    skillMap.set(toolName, {
      skillId: row.instanceId,
      endpoint: deploy.endpoint,
      ...(isOpenclaw && typeof row.instanceConnectionId === 'string'
        ? { openclawConnectionId: row.instanceConnectionId }
        : {}),
    })

    const skillParams = row.skillParameters as ToolParameters | null

    // Param schema: prefer skill-defined parameters, fall back to loose object
    const parameters: {
      type: string
      properties: Record<string, unknown>
      required?: string[]
      [key: string]: unknown
    } = skillParams
      ? {
          type: skillParams.type || 'object',
          properties: skillParams.properties ?? {},
          ...(skillParams.required ? { required: skillParams.required } : {}),
        }
      : {
          type: 'object',
          properties: {} as Record<string, unknown>,
          description: t('convExtractedParams'),
          additionalProperties: true,
        }

    const description = row.apiDoc
      ? `${row.skillDescription || row.skillName}\n\n${row.apiDoc}`
      : row.skillDescription || t('convCallTool', 'zh', { name: row.skillName })

    tools.push({
      type: 'function',
      function: {
        name: toolName,
        description,
        parameters,
      },
    })
  }

  if (skillMap.size > 0) {
    logger.info(`Employee ${employeeId} has ${skillMap.size} skill tools bound`)
  }
}
