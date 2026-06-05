/**
 * SOP Pre-execution Validation — ensures all node configs are complete and linked resources are available
 *
 * No validation on save; validate before execution.
 */

import { db } from '@crewmeld/db'
import { digitalEmployees, humanEmployees, toolInstances, tools } from '@crewmeld/db/schema'
import { createLogger } from '@crewmeld/logger'
import { eq, inArray } from 'drizzle-orm'
import { t } from '@/lib/core/server-i18n'
import type { SopNode, SopSerializedEdge } from '@/types/sop'

const logger = createLogger('SopValidator')

export interface ValidationError {
  nodeId: string
  nodeName: string
  message: string
}

export interface ValidationResult {
  valid: boolean
  errors: ValidationError[]
}

/**
 * Validate whether an SOP definition is ready for execution
 */
export async function validateSopForExecution(
  nodes: SopNode[],
  edges: SopSerializedEdge[]
): Promise<ValidationResult> {
  const errors: ValidationError[] = []

  if (nodes.length === 0) {
    return {
      valid: false,
      errors: [
        { nodeId: '', nodeName: '', message: t('sopValidatorNoNodes', undefined, { name: 'SOP' }) },
      ],
    }
  }

  // 1. Check for isolated nodes (no connections, and not the only node)
  if (nodes.length > 1) {
    const connectedNodeIds = new Set<string>()
    for (const edge of edges) {
      connectedNodeIds.add(edge.source)
      connectedNodeIds.add(edge.target)
    }
    for (const node of nodes) {
      if (!connectedNodeIds.has(node.id)) {
        errors.push({
          nodeId: node.id,
          nodeName: node.name || nodeTypeLabel(node.type),
          message: t('sopValidatorNoConnection', undefined, {
            name: node.name || nodeTypeLabel(node.type),
          }),
        })
      }
    }
  }

  // 2. Collect IDs that need to be queried
  const digitalEmployeeIds = new Set<string>()
  const humanEmployeeIds = new Set<string>()
  const toolInstanceIds = new Set<string>()

  for (const node of nodes) {
    if (node.type === 'digital_employee' && node.executorId) {
      digitalEmployeeIds.add(node.executorId)
      if (node.toolIds) {
        for (const tid of node.toolIds) toolInstanceIds.add(tid)
      }
    }
    if (node.type === 'human_employee' && node.executorId) {
      humanEmployeeIds.add(node.executorId)
    }
  }

  // 3. Batch query linked resources
  const [deMap, heMap, tiMap] = await Promise.all([
    queryDigitalEmployees([...digitalEmployeeIds]),
    queryHumanEmployees([...humanEmployeeIds]),
    queryToolInstances([...toolInstanceIds]),
  ])

  // 4. Validate each node
  for (const node of nodes) {
    const label = node.name || nodeTypeLabel(node.type)

    switch (node.type) {
      case 'digital_employee': {
        // Must select a digital employee
        if (!node.executorId) {
          errors.push({ nodeId: node.id, nodeName: label, message: t('sopValidatorNoEmployee') })
          break
        }
        const de = deMap.get(node.executorId)
        if (!de) {
          errors.push({
            nodeId: node.id,
            nodeName: label,
            message: t('sopValidatorEmployeeNotFound'),
          })
          break
        }
        // Check if the digital employee has bound knowledge bases
        const deConfig = de as { id: string; name: string; config?: Record<string, unknown> | null }
        const hasKnowledgeBase =
          Array.isArray(deConfig.config?.ragflowDatasetIds) &&
          (deConfig.config!.ragflowDatasetIds as string[]).length > 0
        // Without a knowledge base, at least one tool must be selected
        if ((!node.toolIds || node.toolIds.length === 0) && !hasKnowledgeBase) {
          errors.push({
            nodeId: node.id,
            nodeName: label,
            message: t('sopValidatorNoKnowledgeOrTool'),
          })
          break
        }
        // Check if all tools are available
        const unavailableTools: string[] = []
        for (const tid of node.toolIds ?? []) {
          const ti = tiMap.get(tid)
          if (!ti) {
            unavailableTools.push(tid)
          } else if (ti.deployStatus !== 'deployed' && !ti.needsFileMount) {
            // Skip the deploy check for mounted tools: they are deployed
            // per-execution at SOP runtime, not pre-deployed.
            unavailableTools.push(ti.name)
          }
        }
        if (unavailableTools.length > 0) {
          errors.push({
            nodeId: node.id,
            nodeName: label,
            message: t('sopValidatorToolNotDeployed', undefined, {
              tools: unavailableTools.join(', '),
            }),
          })
        }
        break
      }

      case 'human_employee': {
        // Must select a collaborator
        if (!node.executorId) {
          errors.push({ nodeId: node.id, nodeName: label, message: t('sopValidatorNoHuman') })
          break
        }
        const he = heMap.get(node.executorId)
        if (!he) {
          errors.push({ nodeId: node.id, nodeName: label, message: t('sopValidatorHumanNotFound') })
          break
        }
        // Must have contact methods
        if (!he.contactMethods || he.contactMethods.length === 0) {
          errors.push({
            nodeId: node.id,
            nodeName: label,
            message: t('sopValidatorHumanNoContact', undefined, { name: he.name }),
          })
        }
        // Must select a notification method
        const methods = Array.isArray(node.notifyMethod)
          ? node.notifyMethod
          : node.notifyMethod
            ? [node.notifyMethod]
            : []
        if (methods.length === 0) {
          errors.push({
            nodeId: node.id,
            nodeName: label,
            message: t('sopValidatorNoNotifyMethod'),
          })
        }
        break
      }

      // condition / switch / human_confirm do not require additional validation
    }
  }

  if (errors.length > 0) {
    logger.info('SOP pre-execution validation failed', { errorCount: errors.length, errors })
  }

  return { valid: errors.length === 0, errors }
}

function nodeTypeLabel(type: string): string {
  const keyMap: Record<string, Parameters<typeof t>[0]> = {
    digital_employee: 'sopNodeTypeEmployee',
    human_employee: 'sopNodeTypeHuman',
    human_confirm: 'sopNodeTypeHumanConfirm',
    switch: 'sopNodeTypeBranch',
  }
  const key = keyMap[type]
  return key ? t(key) : type
}

async function queryDigitalEmployees(
  ids: string[]
): Promise<Map<string, { id: string; name: string; config?: Record<string, unknown> | null }>> {
  if (ids.length === 0) return new Map()
  const rows = await db
    .select({
      id: digitalEmployees.id,
      name: digitalEmployees.name,
      config: digitalEmployees.config,
    })
    .from(digitalEmployees)
    .where(inArray(digitalEmployees.id, ids))
  return new Map(
    rows.map((r) => [
      r.id,
      { id: r.id, name: r.name, config: r.config as Record<string, unknown> | null },
    ])
  )
}

interface HumanEmployeeInfo {
  id: string
  name: string
  contactMethods: Array<{ type: string; value: string }>
}

async function queryHumanEmployees(ids: string[]): Promise<Map<string, HumanEmployeeInfo>> {
  if (ids.length === 0) return new Map()
  const rows = await db
    .select({
      id: humanEmployees.id,
      name: humanEmployees.name,
      contactMethods: humanEmployees.contactMethods,
    })
    .from(humanEmployees)
    .where(inArray(humanEmployees.id, ids))
  return new Map(
    rows.map((r) => [
      r.id,
      {
        id: r.id,
        name: r.name,
        contactMethods: (r.contactMethods ?? []) as Array<{ type: string; value: string }>,
      },
    ])
  )
}

interface ToolInstanceInfo {
  id: string
  name: string
  deployStatus: string
  /**
   * Mirrors `tools.needs_file_mount` of the template. Mounted tools are
   * deployed per-execution at SOP runtime, so they intentionally have no
   * pre-deployed endpoint — the validator must not flag them as missing.
   */
  needsFileMount: boolean
}

async function queryToolInstances(ids: string[]): Promise<Map<string, ToolInstanceInfo>> {
  if (ids.length === 0) return new Map()
  const rows = await db
    .select({
      id: toolInstances.id,
      name: toolInstances.name,
      deploy: toolInstances.deploy,
      needsFileMount: tools.needsFileMount,
    })
    .from(toolInstances)
    .leftJoin(tools, eq(tools.id, toolInstances.templateId))
    .where(inArray(toolInstances.id, ids))
  return new Map(
    rows.map((r) => {
      const deploy = r.deploy as { status?: string } | null
      return [
        r.id,
        {
          id: r.id,
          name: r.name,
          deployStatus: deploy?.status ?? 'unknown',
          needsFileMount: r.needsFileMount === true,
        },
      ]
    })
  )
}
