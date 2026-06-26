/**
 * Approval pre-validator (Approval Gate)
 *
 * When the SOP engine is about to enter a human_employee (collaborator/approval) node,
 * uses LLM to check whether preceding node execution results constitute valid approval content.
 *
 * On validation failure, the engine routes to the nearest related digital employee node's error exit,
 * avoiding sending invalid/meaningless content to the approver.
 */

import { createLogger } from '@crewmeld/logger'
import { mergeExtraParams, resolveModelConfig } from '@/lib/conversation/model-config'
import type { ConversationModelConfig } from '@/lib/conversation/types'
import { t } from '@/lib/core/server-i18n'
import type { SopNode, SopNodeState, SopWorkflowResult } from '@/types/sop'

const logger = createLogger('ApprovalGate')

export interface ApprovalGateResult {
  /** Whether content is valid and can proceed to approval */
  valid: boolean
  /** Judgment reason */
  reason: string
  /**
   * On validation failure, the digital employee node ID that should take the error exit
   * Determined by the validator combining LLM judgment + execution path
   */
  faultyNodeId?: string
}

interface ValidateParams {
  sopName: string
  sopDescription: string
  executionPath: string[]
  nodeStates: Record<string, SopNodeState>
  workflowResults: Record<string, SopWorkflowResult>
  allNodes: SopNode[]
  targetNode: SopNode
  executorId: string
  workspaceId: string
}

/**
 * Approval pre-validation — check whether preceding node results constitute valid approval content
 *
 * Only called by the engine when about to enter a human_employee node.
 */
export async function validateBeforeApproval(params: ValidateParams): Promise<ApprovalGateResult> {
  const {
    sopName,
    sopDescription,
    executionPath,
    nodeStates,
    workflowResults,
    allNodes,
    targetNode,
    executorId,
    workspaceId,
  } = params

  // Collect execution summaries of preceding digital employee nodes (including tool usage)
  const nodesMap = new Map(allNodes.map((n) => [n.id, n]))
  const digitalEmployeeSteps: Array<{
    nodeId: string
    nodeName: string
    index: number
    summary: string
    toolUsage: string
  }> = []

  for (let i = 0; i < executionPath.length; i++) {
    const nodeId = executionPath[i]
    const nodeDef = nodesMap.get(nodeId)
    if (!nodeDef || nodeDef.type !== 'digital_employee') continue

    const state = nodeStates[nodeId]
    const wfResult = workflowResults[nodeId]
    const output = wfResult?.output ?? state?.output ?? {}

    // Extract readable summary
    const summary = extractReadableSummary(output)

    // Extract tool usage information
    const toolUsage = extractToolUsage(output, nodeDef.toolIds?.length ?? 0)

    digitalEmployeeSteps.push({
      nodeId,
      nodeName: nodeDef.name,
      index: i,
      summary,
      toolUsage,
    })
  }

  // No preceding digital employee nodes -> allow (should not intercept pure manual flows)
  if (digitalEmployeeSteps.length === 0) {
    return { valid: true, reason: 'No preceding digital employee nodes, skipping validation' }
  }

  try {
    const modelConfig = await resolveModelConfig(executorId, workspaceId)
    const llmResult = await callApprovalGateLLM(
      modelConfig,
      sopName,
      sopDescription,
      digitalEmployeeSteps,
      targetNode
    )

    if (llmResult.valid) {
      logger.info('Approval pre-validation passed', {
        sopName,
        targetNode: targetNode.name,
        reason: llmResult.reason,
      })
      return { valid: true, reason: llmResult.reason }
    }

    // Validation failed — determine the node that should take the error exit
    const faultyNodeId = resolveFaultyNode(llmResult.faultyStepIndex, digitalEmployeeSteps)

    logger.warn('Approval pre-validation failed', {
      sopName,
      targetNode: targetNode.name,
      reason: llmResult.reason,
      faultyNodeId,
    })

    return {
      valid: false,
      reason: llmResult.reason,
      faultyNodeId,
    }
  } catch (err) {
    // Degrade to allow on LLM call failure, do not block the flow
    const msg = err instanceof Error ? err.message : String(err)
    logger.error('Approval pre-validation LLM call failed, degrading to allow', { error: msg })
    return { valid: true, reason: `${t('sopCheckDegradeFallback')}: ${msg}` }
  }
}

// --- Internal implementation ---

interface LLMGateResult {
  valid: boolean
  reason: string
  /** LLM-returned "faulty step number" (1-based), used to locate error exit node */
  faultyStepIndex: number | null
}

async function callApprovalGateLLM(
  modelConfig: ConversationModelConfig,
  sopName: string,
  sopDescription: string,
  steps: Array<{
    nodeId: string
    nodeName: string
    index: number
    summary: string
    toolUsage: string
  }>,
  targetNode: SopNode
): Promise<LLMGateResult> {
  const stepsText = steps
    .map((s, i) => `Step ${i + 1} "${s.nodeName}":\n${s.toolUsage}\n${s.summary}`)
    .join('\n\n')

  const systemPrompt = [
    "You are an SOP workflow quality inspector. The workflow is about to enter a human approval step. Determine whether the preceding steps' execution results constitute valid approval content.",
    '',
    '## Evaluation Criteria',
    '- VALID: Preceding steps produced substantive results. Even if some queries returned empty values, the overall information is sufficient for the approver to make a decision',
    '- INVALID: Critical preconditions are not met, making the approval content meaningless. Examples:',
    '  - The department/person referenced in the request does not exist (not "no data available" but "entity does not exist")',
    '  - All steps returned empty/invalid query results, with no information available for approval',
    '  - Core business data is missing, preventing the approver from making any judgment',
    '  - A step had multiple bound tools but some were not called, resulting in missing critical data',
    '',
    '- Important distinctions:',
    '  - "Inventory is 0" is valid business data (indicates a purchase is needed), not an anomaly',
    '  - "Department XYZ does not exist" is a precondition error, which is an anomaly',
    '  - Some queries have results, some are empty, but overall still sufficient for decision -> VALID',
    '  - Tool calls incomplete but existing data sufficient for decision -> VALID',
    '',
    '## Answer Format (strictly follow)',
    'Line 1: VALID or INVALID',
    'Line 2: One sentence reason',
    'Line 3 (only when INVALID): FAULTY_STEP=N (N is the step number that caused the issue, 1-based)',
    '',
    'Example (valid):',
    'VALID',
    'Inventory query returned 0 units, budget and pricing information is complete, sufficient to support procurement approval decision',
    '',
    'Example (invalid):',
    'INVALID',
    'The requested department "XYZ" does not exist, approval content is meaningless',
    'FAULTY_STEP=1',
  ].join('\n')

  const userMessage = [
    `## SOP Name: ${sopName}`,
    sopDescription ? `## SOP Description: ${sopDescription}` : '',
    '',
    '## Preceding Digital Employee Step Execution Results',
    stepsText,
    '',
    `## Upcoming Approval Node: "${targetNode.name}"`,
    '',
    'Please determine whether the above execution results constitute valid approval content:',
  ]
    .filter(Boolean)
    .join('\n')

  const response = await fetch(`${modelConfig.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${modelConfig.apiKey}`,
    },
    // Merge operator-configured passthrough params (e.g. thinking:{"type":"disabled"})
    // so reasoning models can be turned off for this judgment call; max_tokens is
    // generous enough that an un-disabled thinking model still leaves room for the
    // VALID/INVALID body instead of spending the whole budget on reasoning.
    body: JSON.stringify(
      mergeExtraParams(
        {
          model: modelConfig.model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage },
          ],
          stream: false,
          max_tokens: 512,
          temperature: 0,
        },
        modelConfig.extraParams
      )
    ),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`LLM API error (${response.status}): ${errorText.slice(0, 300)}`)
  }

  const data = (await response.json()) as {
    choices: Array<{ message: { content: string | null } }>
  }
  const content = data.choices?.[0]?.message?.content ?? ''

  return parseLLMGateResponse(content)
}

/**
 * Parse LLM validation response
 */
function parseLLMGateResponse(content: string): LLMGateResult {
  const lines = content
    .trim()
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)

  const firstLine = (lines[0] ?? '').toUpperCase()
  const valid = firstLine.startsWith('VALID')
  const reason = lines[1] ?? (valid ? 'Validation passed' : 'Validation failed')

  let faultyStepIndex: number | null = null
  if (!valid) {
    for (const line of lines) {
      const match = line.match(/FAULTY_STEP\s*=\s*(\d+)/i)
      if (match) {
        faultyStepIndex = Number.parseInt(match[1], 10)
        break
      }
    }
  }

  return { valid, reason, faultyStepIndex }
}

/**
 * Locate the node ID for error exit based on LLM-returned faultyStepIndex
 *
 * - Step specified -> return the corresponding nodeId
 * - Not specified (null) -> return the nearest digital employee node
 */
function resolveFaultyNode(
  faultyStepIndex: number | null,
  steps: Array<{ nodeId: string; nodeName: string; index: number }>
): string {
  if (faultyStepIndex !== null && faultyStepIndex >= 1 && faultyStepIndex <= steps.length) {
    return steps[faultyStepIndex - 1].nodeId
  }
  // Fallback: nearest digital employee node
  return steps[steps.length - 1].nodeId
}

/**
 * Extract readable summary from node output
 */
function extractReadableSummary(output: Record<string, unknown>): string {
  // Prefer the summary field (LLM Agent mode output)
  if (typeof output.summary === 'string' && output.summary.length > 0) {
    return output.summary.slice(0, 1000)
  }

  // Try common fields
  for (const key of ['result', 'output', 'content', 'text', 'response']) {
    const val = output[key]
    if (typeof val === 'string' && val.length > 0) {
      return val.slice(0, 1000)
    }
  }

  // Fallback: JSON serialization
  try {
    const json = JSON.stringify(output, null, 2)
    return json.length > 1000 ? `${json.slice(0, 1000)}...` : json
  } catch {
    return '(Unable to parse output)'
  }
}

/**
 * Extract tool usage information from node output
 */
function extractToolUsage(output: Record<string, unknown>, boundToolCount: number): string {
  const toolResults = output.toolResults as Array<{ toolName: string; toolId: string }> | undefined

  if (!toolResults || !Array.isArray(toolResults)) {
    if (boundToolCount > 0) {
      return `[Tool Usage] ${boundToolCount} tools bound, actual call status unknown`
    }
    return '[Tool Usage] No bound tools'
  }

  const calledNames = toolResults.map((r) => r.toolName).join(', ')
  if (toolResults.length < boundToolCount) {
    return `[Tool Usage] ${boundToolCount} tools bound, only ${toolResults.length} actually called: ${calledNames}`
  }
  return `[Tool Usage] ${toolResults.length} tools called: ${calledNames}`
}
