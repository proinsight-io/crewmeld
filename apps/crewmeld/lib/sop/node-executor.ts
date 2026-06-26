import { db, digitalEmployees } from '@crewmeld/db'
import {
  humanEmployees,
  sopDefinitions,
  sopExecutions,
  sopNodeExecutions,
  sopPauseStates,
  taskExecutions,
  workLogs,
} from '@crewmeld/db/schema'
import { createLogger } from '@crewmeld/logger'
import { and, asc, desc, eq, inArray, ne } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { resolveModelConfig } from '@/lib/conversation/model-config'
import type { ConversationModelConfig, OpenAITool } from '@/lib/conversation/types'
import { t } from '@/lib/core/server-i18n'
import { generateApprovalToken } from '@/lib/human-employees/approval-token'
import type { ScopeIdentity } from '@/lib/identity/types'
import { buildImageProxyUrl, loadRagflowConfig, retrieval } from '@/lib/ragflow'
import type { ApiToolSpec } from '@/lib/tools/api-tool-types'
import type { NodeExecutionResult, SopNode, SopStateSnapshot } from '@/types/sop'
import { isAsyncToolsEnabled } from '@/lib/core/config/feature-flags'
import { getBaseUrl } from '@/lib/core/utils/urls'
import {
  executeLLMWithTools,
  type LLMToolExecutionResult,
  runAsyncToolLoop,
  type ToolCallLogEntry,
} from './llm-tool-executor'
import { loadNodeToolResults, rebuildNodeToolExchange } from './rebuild-messages-from-worklogs'
import { getSopNotificationQueue, getSopTimeoutQueue } from './queue'
import {
  buildToolDefinitionsFromIds,
  cleanupMountedTools,
  materializeMountedTools,
  type ToolEndpointInfo,
} from './tool-builder'

const logger = createLogger('SopNodeExecutor')

/**
 * Check if sandbox policy allows sending notifications
 *
 * When triggerData._sandboxPolicy exists, this is a sandbox dry run.
 * Determine whether notifications are allowed based on policy.email and policy.push.
 */
function isSandboxNotificationAllowed(snapshot: SopStateSnapshot): boolean {
  const policy = (snapshot.triggerData as Record<string, unknown> | undefined)?._sandboxPolicy as
    | Record<string, boolean>
    | undefined
  if (!policy) return true // Not sandbox, allow
  // Allow notification if either email or push is enabled
  return !!(policy.email || policy.push)
}

/** Character budget for the task-log history block injected into a digital_employee prompt. */
export const HISTORY_LOG_MAX_CHARS = 6000

/** Per-tool-output preview budget within a single log line.
 *  Raised from 200 → 800 so downstream nodes can read non-immediate-previous tool
 *  outputs (e.g. OCR results ~750 chars) from history instead of relying on
 *  manual field echo via "accumulating pass-through" in node descriptions. */
const TOOL_OUTPUT_PREVIEW_MAX = 800

/** Internal entry used while merging multiple data sources into a chronological history. */
interface HistoryEntry {
  /** Sort key — workLogs.createdAt or sopNodeExecutions.completedAt. */
  timestamp: Date
  /** Node display name. Falls back to 'unknown' when sources lack it. */
  nodeName: string
  /** Stable grouping key — workLogs.taskId or sopNodeExecutions.id. Lets the same node
   *  appear as multiple sections across retries, loop re-entry, or gateway revisits
   *  instead of being merged-then-disproportionately-trimmed. */
  groupKey: string
  /** Single-line content without timestamp or node-name prefix (prefix is added at render time). */
  line: string
}

/** Render entries grouped by execution (taskId / nodeExecution id) into markdown sections,
 *  applying the budget by dropping oldest sections first; if a single remaining section
 *  still exceeds the budget, line trimming kicks in within that section. */
function renderHistorySections(entries: HistoryEntry[]): string {
  if (entries.length === 0) return ''

  // Group consecutive entries by groupKey — same nodeName running twice (retry, loop)
  // produces two adjacent sections instead of being silently merged.
  const groups: Array<{ groupKey: string; nodeName: string; lines: string[] }> = []
  for (const entry of entries) {
    const last = groups[groups.length - 1]
    if (last && last.groupKey === entry.groupKey) {
      last.lines.push(entry.line)
    } else {
      groups.push({ groupKey: entry.groupKey, nodeName: entry.nodeName, lines: [entry.line] })
    }
  }

  const sectionText = (g: { nodeName: string; lines: string[] }): string =>
    `### ${g.nodeName}\n${g.lines.map((l) => `- ${l}`).join('\n')}`

  // Stage 1: drop oldest whole sections until total fits.
  while (groups.length > 1 && groups.map(sectionText).join('\n\n').length > HISTORY_LOG_MAX_CHARS) {
    groups.shift()
  }

  // Stage 2: if one remaining section still exceeds budget, trim lines from its start.
  if (groups.length === 1) {
    const only = groups[0]
    while (only.lines.length > 1 && sectionText(only).length > HISTORY_LOG_MAX_CHARS) {
      only.lines.shift()
    }
  }

  const rendered = groups.map(sectionText).join('\n\n')
  // Stage 3 (defensive): a single oversized line (e.g. a 10KB error message) bypasses
  // both stages above because Stage 2 preserves the last remaining line. Hard-trim the
  // tail so the block never blows past the budget under any input.
  return rendered.length > HISTORY_LOG_MAX_CHARS
    ? `${rendered.slice(0, HISTORY_LOG_MAX_CHARS - 3)}...`
    : rendered
}

/**
 * Build a chronological, node-grouped history block from `work_logs` and
 * `sop_node_executions` for the given SOP execution. Two sources are merged:
 *
 * - `work_logs` (action + tool_call) joined to `task_executions.sopExecutionId`, capturing
 *   digital_employee tool calls and completion summaries. `Started executing` rows
 *   (identified by `metadata.i18nKey === 'logWorkSopStartExecution'`) are filtered out
 *   because the node name is already shown in the section header.
 * - `sop_node_executions` for completed `human_employee` / `human_confirm` nodes, so the
 *   downstream LLM can see approval decisions and comments that never reach `work_logs`.
 *
 * Output format (markdown, grouped by node, no timestamps):
 * ```
 * ### <node name>
 * - <event line>
 * - <event line>
 *
 * ### <next node name>
 * - ...
 * ```
 *
 * When total size exceeds {@link HISTORY_LOG_MAX_CHARS}, the earliest section is dropped
 * first. If the final remaining section is still over budget, lines are trimmed from its
 * start.
 *
 * @returns Markdown-formatted history block, or empty string if no applicable entries.
 */
export async function buildHistoryFromWorkLogs(executionId: string): Promise<string> {
  const logRows = await db
    .select({
      taskId: workLogs.taskId,
      logType: workLogs.logType,
      content: workLogs.content,
      metadata: workLogs.metadata,
      createdAt: workLogs.createdAt,
      taskInput: taskExecutions.input,
    })
    .from(workLogs)
    .innerJoin(taskExecutions, eq(workLogs.taskId, taskExecutions.id))
    .where(
      and(
        eq(taskExecutions.sopExecutionId, executionId),
        inArray(workLogs.logType, ['action', 'tool_call', 'error'])
      )
    )
    .orderBy(workLogs.createdAt)

  const humanRows = await db
    .select({
      id: sopNodeExecutions.id,
      nodeName: sopNodeExecutions.nodeName,
      status: sopNodeExecutions.status,
      result: sopNodeExecutions.result,
      errorMessage: sopNodeExecutions.errorMessage,
      completedAt: sopNodeExecutions.completedAt,
    })
    .from(sopNodeExecutions)
    .where(
      and(
        eq(sopNodeExecutions.executionId, executionId),
        inArray(sopNodeExecutions.nodeType, ['human_employee', 'human_confirm']),
        // Take every terminal state (completed/error/timeout/rejected/...) so the
        // downstream LLM sees approval failures + timeouts, not just successes.
        ne(sopNodeExecutions.status, 'running')
      )
    )
    .orderBy(asc(sopNodeExecutions.completedAt))

  const entries: HistoryEntry[] = []

  for (const row of logRows) {
    const meta = (row.metadata ?? {}) as Record<string, unknown>
    // Skip "Started executing: <node name>" rows — fully redundant once we group by node.
    if (meta.i18nKey === 'logWorkSopStartExecution') continue
    if (!(row.createdAt instanceof Date)) continue

    const taskInput = (row.taskInput ?? {}) as Record<string, unknown>
    const nodeName =
      (typeof meta.nodeName === 'string' && meta.nodeName) ||
      (typeof taskInput.nodeName === 'string' && taskInput.nodeName) ||
      // Suffix the taskId so multiple orphan tasks don't all collide into a single
      // `### unknown` section that mixes their workLogs together.
      `unknown-${row.taskId.slice(-6)}`

    let line: string
    if (row.logType === 'tool_call') {
      const toolDisplay =
        (typeof meta.instanceName === 'string' && meta.instanceName) ||
        (typeof meta.toolName === 'string' && meta.toolName) ||
        'tool'
      // Treat any non-`false` success marker as success — tolerates writers that omit
      // the field or set non-boolean values; explicit `false` is the only failure signal.
      const isSuccess = meta.success !== false
      let outputPreview = ''
      if (meta.output !== undefined && meta.output !== null) {
        try {
          const json = JSON.stringify(meta.output)
          // Failures get a tighter budget — error type matters more than payload detail.
          const max = isSuccess ? TOOL_OUTPUT_PREVIEW_MAX : 100
          const truncated = json.length > max ? `${json.slice(0, max)}...` : json
          outputPreview = isSuccess ? ` (output: ${truncated})` : ` (error: ${truncated})`
        } catch {
          // ignore unserializable outputs
        }
      }
      line = `tool_call: ${toolDisplay} ${isSuccess ? '✓' : '✗'}${outputPreview}`
    } else if (row.logType === 'error') {
      // Failed node completion (logWorkSopExecFailed). [FAILED] prefix signals to the
      // downstream LLM that this is a failure event, not a normal action result.
      line = `[FAILED] ${typeof row.content === 'string' ? row.content : ''}`
    } else {
      line = typeof row.content === 'string' ? row.content : ''
    }

    entries.push({ timestamp: row.createdAt, nodeName, groupKey: row.taskId, line })
  }

  for (const row of humanRows) {
    if (!(row.completedAt instanceof Date)) continue
    const result = (row.result ?? {}) as Record<string, unknown>
    const decision = typeof result.decision === 'string' ? result.decision : ''
    const comment = typeof result.comment === 'string' ? result.comment.trim() : ''
    const nodeName =
      (typeof row.nodeName === 'string' && row.nodeName) || `unknown-${row.id.slice(-6)}`

    let line: string
    if (decision) {
      // Normal approval outcome (approved / rejected).
      line = comment ? `${decision} — ${comment}` : decision
    } else if (row.status === 'error') {
      // Approval node failed (system error, notification dispatch failure, etc).
      line = `[FAILED] ${row.errorMessage ?? 'unknown error'}`
    } else {
      // Other terminal states without a decision (e.g. timeout).
      const detail = row.errorMessage ? `: ${row.errorMessage}` : ''
      line = `[STATUS: ${row.status}]${detail}`
    }

    entries.push({ timestamp: row.completedAt, nodeName, groupKey: row.id, line })
  }

  entries.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())

  return renderHistorySections(entries)
}

/**
 * Node execution dispatcher — routes to the corresponding executor based on node type
 *
 * @param allNodes All SOP node definitions (gateway nodes need to find upstream digital employee's executorId)
 */
export async function executeNode(
  executionId: string,
  node: SopNode,
  snapshot: SopStateSnapshot,
  allNodes?: SopNode[],
  /** Present when resuming a digital-employee node after an async tool callback. */
  resume?: { taskId: string }
): Promise<NodeExecutionResult> {
  switch (node.type) {
    case 'digital_employee':
      return executeDigitalEmployeeNode(executionId, node, snapshot, allNodes, resume)
    case 'human_employee':
      return executeHumanEmployeeNode(executionId, node, snapshot)
    case 'human_confirm':
      return executeHumanConfirmNode(executionId, node, snapshot)
    case 'switch':
      return executeGatewayNode(executionId, node, snapshot, allNodes)
    default:
      return { error: `Unknown node type: ${node.type}` }
  }
}

/**
 * Condition/multi-path gateway node — does not execute tasks, routes based on upstream output
 *
 * If the upstream node is a digital employee, reuse that employee's LLM model for condition evaluation;
 * otherwise fall back to field extraction + rule comparison.
 */
async function executeGatewayNode(
  executionId: string,
  node: SopNode,
  snapshot: SopStateSnapshot,
  allNodes?: SopNode[]
): Promise<NodeExecutionResult> {
  const config = node.conditionConfig

  // Get value from upstream node output (output of the most recently completed node)
  const lastNodeId = snapshot.executionPath[snapshot.executionPath.length - 1]
  const lastState = lastNodeId ? snapshot.nodeStates[lastNodeId] : undefined
  const lastOutput = lastState?.output ?? {}
  const lastWfResult = lastNodeId ? snapshot.workflowResults[lastNodeId] : undefined
  const upstream = lastWfResult?.output ?? lastOutput

  // Check if upstream is a digital employee node
  const lastNodeDef = lastNodeId && allNodes ? allNodes.find((n) => n.id === lastNodeId) : undefined
  const isUpstreamDigitalEmployee = lastNodeDef?.type === 'digital_employee'

  // ── LLM takeover mode (upstream is digital employee) ──
  if (isUpstreamDigitalEmployee && lastNodeDef.executorId) {
    try {
      const workspaceId = await resolveWorkspaceIdFromExecution(executionId)
      const modelConfig = await resolveModelConfig(lastNodeDef.executorId, workspaceId)
      const upstreamText = JSON.stringify(upstream, null, 2)

      const switchResult = await evaluateSwitchWithLLM(modelConfig, upstreamText, node)

      if (switchResult.insufficient) {
        // Insufficient data — try supplementary tool calls for unused upstream tools
        logger.info(
          'Gateway node determined insufficient data, attempting supplementary tool calls',
          {
            nodeId: node.id,
            upstreamNodeId: lastNodeId,
            reason: switchResult.reason,
          }
        )

        const supplementResult = await supplementUpstreamTools(
          executionId,
          node,
          upstream,
          lastNodeDef,
          snapshot,
          modelConfig
        )

        if (supplementResult) {
          // Supplement succeeded, build enriched upstream output with supplement data for re-evaluation
          const enrichedUpstream = mergeSupplementIntoUpstream(upstream, supplementResult)
          const enrichedText = JSON.stringify(enrichedUpstream, null, 2)
          const retryResult = await evaluateSwitchWithLLM(modelConfig, enrichedText, node)

          logger.info('Gateway node re-evaluation after supplement completed', {
            nodeId: node.id,
            gatewayValue: retryResult.value,
            supplementToolCount: supplementResult.toolCount,
          })

          // Merge supplement results back into upstream digital employee node's business data
          // Ensure approval notifications and subsequent nodes can see complete tool results and summaries
          if (lastNodeId) {
            const existingOutput = snapshot.nodeStates[lastNodeId]?.output ?? {}
            const mergedOutput = mergeSupplementIntoUpstream(existingOutput, supplementResult)
            snapshot.nodeStates[lastNodeId] = {
              ...snapshot.nodeStates[lastNodeId],
              output: mergedOutput,
            }
          }

          return {
            output: {
              _gatewayValue: retryResult.value,
              _llmEvaluated: true,
              _supplemented: true,
              ...enrichedUpstream,
            },
          }
        }

        // Cannot supplement -> DEFAULT
        logger.info('Gateway node cannot supplement, routing to default exit', { nodeId: node.id })
        return {
          output: { _gatewayValue: null, _llmEvaluated: true, _insufficient: true, ...upstream },
        }
      }

      logger.info('Gateway node LLM evaluation completed', {
        nodeId: node.id,
        nodeType: node.type,
        gatewayValue: switchResult.value,
        upstreamNodeId: lastNodeId,
      })
      return { output: { _gatewayValue: switchResult.value, _llmEvaluated: true, ...upstream } }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error('Gateway node LLM evaluation failed', { nodeId: node.id, error: msg })
      return { error: `Gateway LLM evaluation failed: ${msg}`, errorExit: true }
    }
  }

  // ── Fallback mode (upstream is not a digital employee, or executorId not configured) ──
  if (config?.field) {
    // Field specified -> dot-path value extraction
    const fieldValue = config.field
      .split('.')
      .reduce<unknown>(
        (acc, key) =>
          acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[key] : undefined,
        upstream
      )
    logger.info('Gateway node field value extraction', {
      nodeId: node.id,
      nodeType: node.type,
      field: config.field,
      fieldValue,
      upstreamNodeId: lastNodeId,
    })
    return { output: { _gatewayField: config.field, _gatewayValue: fieldValue, ...upstream } }
  }

  // No field, no LLM -> use full output JSON string for comparison
  const fullText = JSON.stringify(upstream)
  logger.info('Gateway node full output comparison', {
    nodeId: node.id,
    nodeType: node.type,
    upstreamNodeId: lastNodeId,
  })
  return { output: { _gatewayValue: fullText, ...upstream } }
}

/** Switch evaluation result */
interface SwitchEvalResult {
  /** Matched branch value, null means default exit */
  value: string | null
  /** Insufficient data, cannot make a reliable judgment */
  insufficient: boolean
  /** Reason for insufficiency (only set when insufficient=true) */
  reason?: string
}

/**
 * Switch multi-path branching: LLM selects from a given list of values
 *
 * Supports three answer types: branch number, DEFAULT, INSUFFICIENT
 * - Branch number: sufficient data, matched a specific branch
 * - DEFAULT: sufficient data but no matching branch
 * - INSUFFICIENT: upstream data insufficient to make any judgment
 */
async function evaluateSwitchWithLLM(
  modelConfig: ConversationModelConfig,
  upstreamText: string,
  node: SopNode
): Promise<SwitchEvalResult> {
  const exits = (node.exits ?? []).filter(
    (e) => e.type !== 'error' && e.condition?.type !== 'always'
  )
  const caseValues = exits.map((e) => String(e.condition?.value ?? e.label))

  if (caseValues.length === 0) return { value: null, insufficient: false }

  // Find the default exit label (for display to LLM)
  const defaultExit = (node.exits ?? []).find(
    (e) => e.condition?.type === 'always' || (!e.condition && e.type !== 'error')
  )
  const defaultLabel = defaultExit?.label ?? 'Other cases'

  const systemPrompt = [
    'You are a multi-path branch routing assistant in an SOP workflow.',
    'You will receive the complete output from the previous step (including text summary and raw tool call return data), along with several selectable branch condition descriptions.',
    'Analyze the output content semantically to determine which branch condition the upstream data satisfies.',
    '',
    '## Evaluation Rules',
    '- **Important: You must make independent judgments based on the raw data in the upstream output (actual values in toolResults), not just rely on the text description in summary**',
    '- If the summary says "to be determined later" but the raw data is sufficient to make a judgment, you should judge directly based on the data',
    '- Example: If the branch condition is "budget sufficient", and the upstream toolResults contain purchase amount and available budget values, you should compare the values and judge even if the summary does not provide a conclusion',
    '- Only select a branch when the upstream data **clearly satisfies** that branch condition',
    '- If the upstream data is **opposite** to the branch condition (e.g. condition requires "sufficient" but data shows "insufficient"), you **must select DEFAULT**',
    '- If the upstream output **lacks** the key data needed to make a judgment (e.g. branch condition involves "budget" but output contains no budget information), answer INSUFFICIENT',
    '- Do not guess or assume missing data',
    '',
    '## Answer Format (strictly follow, exactly two lines)',
    'Line 1: One sentence explaining the judgment basis (extract key values and compare against branch conditions)',
    'Line 2: ONLY write the **branch number** (e.g. 1, 2, 3), or DEFAULT, or INSUFFICIENT. Do NOT write the branch description text — only the number.',
    '',
    'Example:',
    '  Total inventory 5 units >= requested 2 units, satisfies branch 1 condition',
    '  1',
    '',
    '  Total inventory 0 units < requested 2 units, does not satisfy any branch condition',
    '  DEFAULT',
  ].join('\n')

  const userMessage = [
    '## Previous Step Output',
    upstreamText,
    '',
    '## Selectable Branches',
    caseValues.map((v, i) => `${i + 1}. ${v}`).join('\n'),
    `DEFAULT. ${defaultLabel}`,
    '',
    'Analyze the upstream data and determine which branch condition is satisfied (write the exact branch text or DEFAULT):',
  ].join('\n')

  const answer = await callLLMSimple(modelConfig, systemPrompt, userMessage)
  const fullText = answer.trim()
  const lines = fullText
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)

  logger.info('LLM Switch evaluation Q&A', {
    nodeId: node.id,
    caseValues,
    llmAnswer: fullText,
  })

  // Scan all lines for conclusion (compatible with single/multi-line/reasoning mixed format)
  // Priority check for INSUFFICIENT / DEFAULT / number
  for (const line of lines) {
    const upper = line.toUpperCase()
    if (upper.startsWith('INSUFFICIENT')) {
      const nextIdx = lines.indexOf(line) + 1
      const reason =
        (nextIdx < lines.length ? lines[nextIdx] : null) ?? 'Insufficient upstream data'
      return { value: null, insufficient: true, reason }
    }
  }

  for (const line of lines) {
    if (line.toUpperCase() === 'DEFAULT') {
      // Post-process: check if reasoning lines describe data missing
      // LLM often misclassifies "data missing prevents judgment" as DEFAULT instead of INSUFFICIENT
      // Regex requires "missing" class words co-occurring with branch condition keywords to reduce false positives
      const reasoningText = lines.filter((l) => l.toUpperCase() !== 'DEFAULT').join(' ')
      const caseKeywords = caseValues.map((v) => v.slice(0, 4)).join('|')
      const insufficientWords = t('llmInsufficientWords', 'zh')
      const dataWords = t('llmDataWords', 'zh')
      const insufficientPatterns = new RegExp(
        `(?:${insufficientWords}).{0,20}(?:${caseKeywords}|${dataWords})`
      )
      if (insufficientPatterns.test(reasoningText)) {
        logger.info(
          'LLM Switch DEFAULT upgraded to INSUFFICIENT (reasoning lines describe missing data)',
          {
            reasoning: reasoningText.slice(0, 200),
          }
        )
        return { value: null, insufficient: true, reason: reasoningText.slice(0, 200) }
      }
      return { value: null, insufficient: false }
    }
  }

  // Scan all lines, find standalone numbers (e.g. "1", "2")
  for (const line of lines) {
    const numMatch = line.match(/^(\d+)\.?$/)
    if (numMatch) {
      const idx = Number.parseInt(numMatch[1], 10) - 1
      if (idx >= 0 && idx < caseValues.length) {
        return { value: caseValues[idx], insufficient: false }
      }
    }
  }

  // Only match branch values in conclusion line (last line), avoid false positives from branch names in reasoning text
  const conclusionLine = lines[lines.length - 1] ?? ''

  // Exact substring match on conclusion line
  const matched = caseValues.find((v) => conclusionLine.includes(v))
  if (matched) {
    logger.info('LLM Switch matched branch value from conclusion line', { matched, conclusionLine })
    return { value: matched, insufficient: false }
  }

  // Number patterns in conclusion line (e.g. "Branch 1" "branch: 1" and CJK equivalents)
  const zhBranch = t('llmBranchSelectWords', 'zh')
  const zhColon = t('llmFullwidthColon', 'zh')
  const zhPeriod = t('llmFullwidthPeriod', 'zh')
  for (let i = 0; i < caseValues.length; i++) {
    const patterns = [
      new RegExp(`(?:${zhBranch}|branch|select|option)[${zhColon}:.]?\\s*${i + 1}\\b`, 'i'),
      new RegExp(`\\b${i + 1}\\s*[.${zhPeriod}]\\s*${caseValues[i].slice(0, 4)}`),
    ]
    if (patterns.some((p) => p.test(conclusionLine))) {
      logger.info('LLM Switch pattern matched branch from conclusion line', {
        index: i + 1,
        value: caseValues[i],
      })
      return { value: caseValues[i], insufficient: false }
    }
  }

  // Fuzzy fallback: scan ALL lines (not just conclusion) for branch numbers or exact text
  for (const line of lines) {
    // Skip reasoning lines that are clearly explanations
    if (line.length > 60) continue
    const numOnlyMatch = line.match(/^(\d+)\.?\s*$/)
    if (numOnlyMatch) {
      const idx = Number.parseInt(numOnlyMatch[1], 10) - 1
      if (idx >= 0 && idx < caseValues.length) {
        logger.info('LLM Switch fuzzy matched branch number from non-conclusion line', {
          index: idx + 1,
          value: caseValues[idx],
          line,
        })
        return { value: caseValues[idx], insufficient: false }
      }
    }
    // Fuzzy text match: check if line contains substantial overlap with a case value
    for (let i = 0; i < caseValues.length; i++) {
      const caseChars = caseValues[i].replace(/\s/g, '')
      const lineChars = line.replace(/\s/g, '')
      if (caseChars.length >= 4 && lineChars.includes(caseChars)) {
        logger.info('LLM Switch fuzzy text matched branch from line', {
          index: i + 1,
          value: caseValues[i],
          line,
        })
        return { value: caseValues[i], insufficient: false }
      }
    }
  }

  logger.warn('LLM Switch evaluation matched no branch, routing to default exit', {
    answer: fullText,
    caseValues,
  })
  return { value: null, insufficient: false }
}

/** Tool supplement result */
interface SupplementResult {
  summary: string | null
  toolResults: Array<{
    toolName: string
    toolId: string
    input: Record<string, unknown>
    output: unknown
    round: number
  }>
  toolCount: number
}

/**
 * Merge supplementary tool results back into upstream digital employee node business data
 *
 * - Append toolResults to existing toolResults array
 * - Append supplement summary to summary
 * - Ensure approval notifications and subsequent nodes can see complete data
 */
function mergeSupplementIntoUpstream(
  existingOutput: Record<string, unknown>,
  supplement: SupplementResult
): Record<string, unknown> {
  const merged = { ...existingOutput }

  // Merge toolResults — append supplementary tool results to original array
  const existingToolResults = Array.isArray(merged.toolResults) ? merged.toolResults : []
  merged.toolResults = [...existingToolResults, ...supplement.toolResults]

  // Merge summary — append supplement summary
  if (supplement.summary) {
    const existingSummary = typeof merged.summary === 'string' ? merged.summary : ''
    merged.summary = existingSummary
      ? `${existingSummary}\n\n---\n\n[Supplementary Query] ${supplement.summary}`
      : supplement.summary
  }

  // Update tool call round counter
  merged.rounds =
    (typeof merged.rounds === 'number' ? merged.rounds : 0) + (supplement.toolCount > 0 ? 1 : 0)

  return merged
}

/**
 * Supplement upstream digital employee's unused tools
 *
 * Check upstream node's bound toolIds against actual toolResults,
 * find uncalled tools, execute supplements via LLM, return supplementary data.
 */
async function supplementUpstreamTools(
  executionId: string,
  gatewayNode: SopNode,
  upstream: Record<string, unknown>,
  upstreamNodeDef: SopNode,
  snapshot: SopStateSnapshot,
  modelConfig: ConversationModelConfig
): Promise<SupplementResult | null> {
  const allToolIds = upstreamNodeDef.toolIds ?? []
  if (allToolIds.length === 0) return null

  // Extract called tool IDs from upstream output.toolResults
  const rawToolResults = upstream.toolResults
  const toolResults = Array.isArray(rawToolResults)
    ? (rawToolResults as Array<{ toolId: string }>)
    : []
  const calledToolIds = new Set(toolResults.map((r) => r.toolId))
  const uncalledToolIds = allToolIds.filter((id) => !calledToolIds.has(id))

  if (uncalledToolIds.length === 0) {
    logger.info('All upstream tools already called, cannot supplement', { nodeId: gatewayNode.id })
    return null
  }

  logger.info('Found uncalled upstream tools', {
    nodeId: gatewayNode.id,
    uncalledCount: uncalledToolIds.length,
    uncalledToolIds,
  })

  // Build definitions for uncalled tools
  const {
    tools: uncalledTools,
    endpointMap,
    apiTools: uncalledApiTools,
  } = await buildToolDefinitionsFromIds(uncalledToolIds)
  if (uncalledTools.length === 0) return null

  // Collect branch condition descriptions so LLM knows what data is needed
  const exits = (gatewayNode.exits ?? []).filter((e) => e.type !== 'error')
  const branchDescriptions = exits.map((e) => e.condition?.value ?? e.label).join(', ')

  // Extract original request context from triggerData
  const { _meta, ...userTriggerData } = (snapshot.triggerData ?? {}) as Record<string, unknown>

  const systemPrompt =
    [
      'You are a data completion assistant in an SOP workflow.',
      'The previous step produced incomplete data, and you need to call tools to supplement the missing information.',
      '',
      '## Existing Upstream Data',
      JSON.stringify(upstream, null, 2),
      '',
      '## Conditions to Evaluate in Downstream Branches',
      branchDescriptions,
      '',
      '## Trigger Parameters',
      JSON.stringify(userTriggerData, null, 2),
      '',
      'Call your available tools to retrieve the missing data, then summarize the supplemented information.',
    ].join('\n') + getLanguageInstruction(snapshot)

  const userMessage = 'Please call tools to supplement the missing data.'

  try {
    const result = await executeLLMWithTools({
      modelConfig,
      tools: uncalledTools,
      toolEndpoints: endpointMap,
      apiTools: uncalledApiTools,
      systemPrompt,
      userMessage,
      maxRounds: 3,
      // Carry the SOP execution id through the supplement path so any
      // needsFileMount tool gets `_sopFileDir` + `_sopExecutionId` injected
      // (lib/sop/llm-tool-executor.ts:284). Without this the tool falls
      // back to its own input only and ends up reading the wrong /root/io
      // subdir — silent on the BFF side, FileNotFoundError on the pod side.
      sopExecutionId: executionId,
    })

    if (result.toolResults.length === 0) {
      logger.info('Supplement produced no tool calls', { nodeId: gatewayNode.id })
      return null
    }

    // Do not return results when all supplement tools fail, avoid re-evaluation with bad data
    if (result.error) {
      logger.warn('Supplement tool execution error, abandoning supplement', {
        nodeId: gatewayNode.id,
        error: result.error,
      })
      return null
    }

    logger.info('Tool supplement completed', {
      nodeId: gatewayNode.id,
      toolCount: result.toolResults.length,
      summary: result.summary?.slice(0, 200),
    })

    return {
      summary: result.summary,
      toolResults: result.toolResults,
      toolCount: result.toolResults.length,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error('Supplement tool call failed', { nodeId: gatewayNode.id, error: msg })
    return null
  }
}

/**
 * Simple non-streaming LLM call (no tools)
 */
async function callLLMSimple(
  config: ConversationModelConfig,
  systemPrompt: string,
  userMessage: string
): Promise<string> {
  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      stream: false,
      max_tokens: 128,
      temperature: 0,
    }),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`LLM API error (${response.status}): ${errorText.slice(0, 300)}`)
  }

  const data = (await response.json()) as {
    choices: Array<{ message: { content: string | null } }>
  }
  return data.choices?.[0]?.message?.content ?? ''
}

/**
 * Digital employee node executor — prefers toolIds (LLM Agent), falls back to workflowId (DAG engine)
 */
async function executeDigitalEmployeeNode(
  executionId: string,
  node: SopNode,
  snapshot: SopStateSnapshot,
  allNodes?: SopNode[],
  resume?: { taskId: string }
): Promise<NodeExecutionResult> {
  // Has tools or digital employee bound to knowledge base, use LLM Agent path
  // Knowledge base determined by digital employee config, no longer depends on node.useKnowledgeBase toggle
  if ((node.toolIds && node.toolIds.length > 0) || node.executorId) {
    return executeDigitalEmployeeWithLLMTools(executionId, node, snapshot, allNodes, resume)
  }

  const nodeExecId = nanoid()

  await db.insert(sopNodeExecutions).values({
    id: nodeExecId,
    executionId,
    nodeId: node.id,
    nodeName: node.name,
    nodeType: node.type,
    status: 'running',
    startedAt: new Date(),
  })

  if (!node.workflowId) {
    const errorMessage = `Digital employee node "${node.name}" has no bound workflow or tools`
    await db
      .update(sopNodeExecutions)
      .set({ status: 'error', errorMessage, completedAt: new Date() })
      .where(eq(sopNodeExecutions.id, nodeExecId))
    return { error: errorMessage }
  }

  // Workflow executor removed in P4 — digital-employee nodes with a
  // bound workflowId can no longer run via executeWorkflowCore.
  const errorMessage = `Workflow-based node execution is not supported (workflowId=${node.workflowId}). Use SOP nodes with LLM tools instead.`
  logger.warn(`[${executionId}] ${errorMessage}`, { nodeId: node.id })
  await db
    .update(sopNodeExecutions)
    .set({ status: 'error', errorMessage, completedAt: new Date() })
    .where(eq(sopNodeExecutions.id, nodeExecId))
  return { error: errorMessage }
}

/**
 * Digital employee node — LLM Agent multi-tool execution
 */
async function executeDigitalEmployeeWithLLMTools(
  executionId: string,
  node: SopNode,
  snapshot: SopStateSnapshot,
  allNodes?: SopNode[],
  resume?: { taskId: string }
): Promise<NodeExecutionResult> {
  // Async suspend/resume splits one logical node execution into two function
  // calls (dispatch→suspend, then callback→resume). On resume, reuse the
  // sop_node_executions row the suspending call left in 'running' instead of
  // inserting a second one — otherwise a single-node SOP accrues two node rows
  // (the first stranded in 'running'), which double-counts node progress in the
  // task center and emits a duplicate node_started timeline event.
  let nodeExecId: string
  let nodeExecStartedAt: Date
  const [resumedNodeExec] = resume
    ? await db
        .select({ id: sopNodeExecutions.id, startedAt: sopNodeExecutions.startedAt })
        .from(sopNodeExecutions)
        .where(
          and(
            eq(sopNodeExecutions.executionId, executionId),
            eq(sopNodeExecutions.nodeId, node.id),
            eq(sopNodeExecutions.status, 'running')
          )
        )
        .orderBy(desc(sopNodeExecutions.startedAt))
        .limit(1)
    : []

  if (resumedNodeExec) {
    nodeExecId = resumedNodeExec.id
    nodeExecStartedAt = resumedNodeExec.startedAt ?? new Date()
  } else {
    // Fresh run, or a resume whose suspend row vanished — start a new record.
    nodeExecId = nanoid()
    nodeExecStartedAt = new Date()
    await db.insert(sopNodeExecutions).values({
      id: nodeExecId,
      executionId,
      nodeId: node.id,
      nodeName: node.name,
      nodeType: node.type,
      status: 'running',
      startedAt: nodeExecStartedAt,
    })
  }

  if (!node.executorId) {
    const errorMessage = `Digital employee node "${node.name}" has no assigned digital employee (required for model resolution)`
    await db
      .update(sopNodeExecutions)
      .set({ status: 'error', errorMessage, completedAt: new Date() })
      .where(eq(sopNodeExecutions.id, nodeExecId))
    return { error: errorMessage }
  }

  // Hoisted so the finally block can observe what mounted tools were
  // materialized. Under the B1 shared-mount model these Pods are
  // long-lived and cleanup is a no-op; the list is mostly diagnostic.
  let deployedMountedTools: Array<{
    toolName: string
    skillId: string
    instanceId: string
  }> = []

  try {
    // Query digital employee name and persona (persona retained for log signal only; not injected into prompt)
    const [employee] = await db
      .select({ name: digitalEmployees.name, persona: digitalEmployees.persona })
      .from(digitalEmployees)
      .where(eq(digitalEmployees.id, node.executorId))
      .limit(1)

    const employeeName = employee?.name ?? 'Digital Employee'
    const employeePersona = employee?.persona?.trim() || ''

    // Query workspaceId — get from any SOP-associated workflow, or use empty string
    const workspaceId = await resolveWorkspaceIdFromExecution(executionId)

    // Resolve model config
    const modelConfig = await resolveModelConfig(node.executorId, workspaceId)

    // Build tool definitions
    const { tools, endpointMap, apiTools } = node.toolIds?.length
      ? await buildToolDefinitionsFromIds(node.toolIds)
      : {
          tools: [] as OpenAITool[],
          endpointMap: new Map<string, ToolEndpointInfo>(),
          apiTools: new Map<string, { spec: ApiToolSpec; forwardIdentity?: boolean }>(),
        }

    // For any tool with needsFileMount=true, deploy a per-execution Pod
    // For any tool with needsFileMount=true, ensure the shared instance
    // Pod exists and patch its endpoint into the map. Under the B1
    // shared-mount model these Pods are long-lived; the returned list
    // is observational only — the finally block does not tear them down.
    deployedMountedTools = await materializeMountedTools(endpointMap, executionId)

    // URL prefix the tool will get as `_sopFileUrlPrefix` for output
    // links it returns. Must point at the project's proxy route.
    const appBaseUrl = getBaseUrl().replace(/\/$/, '')
    const sopFileUrlPrefix = `${appBaseUrl}/api/sop/${executionId}/files`

    logger.info('[SOP Node] Resources ready - digital employee/model/tools', {
      executionId,
      nodeId: node.id,
      nodeName: node.name,
      employeeName,
      hasPersona: !!employeePersona,
      model: modelConfig.model,
      modelBaseUrl: modelConfig.baseUrl,
      toolCount: tools.length,
      toolNames: tools.map((t) => t.function.name),
      toolDetails: tools.map((t) => ({ name: t.function.name, desc: t.function.description })),
    })

    // Build context: previous node output + original user message
    const previousOutput =
      snapshot.nodeStates[snapshot.executionPath[snapshot.executionPath.length - 1]]?.output ?? {}

    // Extract original user message from triggerData (input field injected during conversation bridging)
    const { _meta, ...userTriggerData } = (snapshot.triggerData ?? {}) as Record<string, unknown>
    const originalUserMessage = (userTriggerData.input as string) ?? ''
    const meta = _meta as Record<string, unknown> | undefined
    const currentUserId = meta?.userId as string | undefined
    const currentSenderName = meta?.senderName as string | undefined
    const currentChannel = meta?.channel as string | undefined

    // Read the platform-stamped caller identity injected by the sop-bridge at
    // dispatch time (spec §6 _meta.identity contract).  Falls back to undefined
    // when the trigger is not an IM channel message (API / webhook), in which
    // case forwardIdentity tools fail-closed at the runner.
    const identityMeta = (meta?.identity as ScopeIdentity | undefined) ?? undefined

    const systemPromptSections = [
      `You are digital employee "${employeeName}", executing a task step in an SOP workflow.`,
    ]

    // Persona is intentionally NOT injected here: SOP nodes operate in task-execution context,
    // where deterministic, tool-driven output is preferred over conversational persona styling.
    // The employee's persona still applies in the chat/conversation engine.

    // Inject the identity of the user who triggered this conversation, so tools can be scoped to that user.
    // Without this block, the LLM cannot resolve placeholders like "userId" in node descriptions and
    // would pass the literal string instead of the actual value.
    if (currentUserId) {
      // Each field carries a short gloss so the node LLM knows exactly what it
      // is (e.g. userId is the IM account id, NOT the employee number) and can
      // pass the right value to tools.
      const userLines = [`- userId (IM account id, not the employee number): ${currentUserId}`]
      if (currentSenderName) userLines.push(`- name (display name): ${currentSenderName}`)
      if (currentChannel) userLines.push(`- via channel: ${currentChannel}`)
      // Surface the resolved org identity so the node LLM can reason about the
      // caller's role/department and route work accordingly.
      if (identityMeta?.positions?.length) {
        userLines.push(`- positions (job titles): ${identityMeta.positions.join(', ')}`)
      }
      if (identityMeta?.employeeNo) {
        userLines.push(`- employeeNo (HR employee number): ${identityMeta.employeeNo}`)
      }
      if (identityMeta?.scope?.orgUnitIds?.length) {
        userLines.push(`- orgUnitIds (department ids): ${identityMeta.scope.orgUnitIds.join(', ')}`)
      }
      if (identityMeta?.leaderId) {
        userLines.push(`- leaderId (direct manager's account id): ${identityMeta.leaderId}`)
      }
      systemPromptSections.push(
        '',
        '## Current User Context',
        userLines.join('\n'),
        '',
        'When the task involves user-scoped operations (filtering records by owner, ownership checks, permission boundaries), pass this userId verbatim as the user identifier to tools. Never substitute a placeholder string or invent a different value.'
      )
    }

    // Filter out _gateway* metadata fields from previousOutput, keep only business data
    const contextOutput: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(previousOutput)) {
      if (!k.startsWith('_gateway') && k !== '_llmEvaluated') {
        contextOutput[k] = v
      }
    }
    const hasContextOutput = Object.keys(contextOutput).length > 0

    systemPromptSections.push(
      '',
      '## Core Directive (Highest Priority)',
      `Your current task is: ${node.description || node.name}`
    )

    if (tools.length > 0) {
      const toolNameList = tools
        .map((t) => `- ${t.function.name}: ${t.function.description}`)
        .join('\n')
      systemPromptSections.push(
        '',
        '## Your Available Tools (all must be called)',
        toolNameList,
        '',
        `**Important: You must call all ${tools.length} tools above.** These tools are the required data sources for this step. Each tool retrieves information from a different dimension; missing any one will result in incomplete data for subsequent workflow steps.`,
        'Call all tools in logical order. After completing all calls, combine context information and all tool results to provide a comprehensive summary.'
      )
    }

    if (hasContextOutput) {
      systemPromptSections.push(
        '',
        '## Workflow Context (results from preceding steps, for your reference)',
        JSON.stringify(contextOutput, null, 2)
      )
    }

    // Inject chronological task-log history sourced from work_logs (action + tool_call
    // entries from earlier nodes in this SOP execution). Gives the LLM continuity across
    // multiple steps without re-loading raw tool results from the snapshot.
    try {
      const taskLogHistory = await buildHistoryFromWorkLogs(executionId)
      if (taskLogHistory) {
        systemPromptSections.push(
          '',
          '## Task Log History (chronological events from earlier steps in this SOP)',
          taskLogHistory
        )
      }
    } catch (historyErr) {
      logger.warn('Task log history build failed, continuing without it', {
        executionId,
        nodeId: node.id,
        error: historyErr instanceof Error ? historyErr.message : String(historyErr),
      })
    }

    // Always query knowledge bases bound to digital employee, inject relevant content into system prompt, let model decide whether to use it
    try {
      const [empConfig] = await db
        .select({ config: digitalEmployees.config })
        .from(digitalEmployees)
        .where(eq(digitalEmployees.id, node.executorId))
        .limit(1)
      const config = empConfig?.config as Record<string, unknown> | null
      const datasetIds = Array.isArray(config?.ragflowDatasetIds)
        ? (config.ragflowDatasetIds as string[]).filter(
            (id): id is string => typeof id === 'string'
          )
        : []
      logger.info('[SOP Node] Knowledge base binding status', {
        executionId,
        nodeId: node.id,
        datasetIds,
        datasetCount: datasetIds.length,
      })
      if (datasetIds.length > 0) {
        const ragflowConfig = await loadRagflowConfig()
        const kbQuery = originalUserMessage || node.description || node.name || ''
        logger.info('[SOP Node] Knowledge base retrieval request - sending to RAGflow', {
          nodeId: node.id,
          query: kbQuery.slice(0, 200),
          datasetIds,
          topK: 5,
          similarityThreshold: 0.2,
        })
        const kbData = await retrieval(ragflowConfig, {
          datasetIds,
          query: kbQuery,
          topK: 5,
          similarityThreshold: 0.2,
        })
        const chunks = kbData.chunks ?? []
        logger.info('[SOP Node] Knowledge base retrieval completed - document chunks returned', {
          nodeId: node.id,
          datasetCount: datasetIds.length,
          chunkCount: chunks.length,
          chunkPreviews: chunks.map((c, i) => ({
            index: i,
            contentLength: c.content?.length ?? 0,
            preview: c.content?.slice(0, 100) ?? '',
          })),
        })
        if (chunks.length > 0) {
          // Preserve images RagFlow attaches to chunks (e.g. PDF figures) by
          // appending a markdown image pointing at the same-origin proxy; the
          // chat UI renders it inline.
          const referenceText = chunks
            .map((c, i) => {
              const body = c.image_id
                ? `${c.content}\n\n![](${buildImageProxyUrl(c.image_id)})`
                : c.content
              return `[Reference ${i + 1}] ${body}`
            })
            .join('\n\n')
          systemPromptSections.push(
            '',
            '## Knowledge Base References (from linked knowledge bases, use as appropriate)',
            referenceText
          )
        }
      } else {
        logger.info('[SOP Node] Digital employee has no bound knowledge base, skipping retrieval', {
          nodeId: node.id,
        })
      }
    } catch (kbErr) {
      logger.warn('SOP node knowledge base retrieval failed, skipping KB injection', {
        nodeId: node.id,
        error: kbErr,
      })
    }

    systemPromptSections.push(
      '',
      '## Original User Request',
      originalUserMessage || '(None)',
      '',
      '## Trigger Parameters',
      JSON.stringify(userTriggerData, null, 2),
      '',
      '## Requirements',
      '- Based on task needs, decide whether to call tools, reference knowledge base materials, or use both',
      '- You must base your answers on data returned by tools or content from the knowledge base; do not fabricate results',
      '- Do not fabricate content not found in the knowledge base; if information is insufficient, state so honestly',
      ...(tools.length > 0 ? ['- If multiple tools are needed, call them in logical order'] : []),
      '- Context information is for reference only; your core responsibility is to execute the current task',
      '- After completion, combine context, tool results, and knowledge base materials to provide a comprehensive summary',
      '',
      '## Error Handling (system-level failures only)',
      'Only reply with [ERROR] prefix and stop immediately when encountering the following **system-level failures**:',
      '- Tool API itself returns an error (HTTP 5xx, timeout, connection failure)',
      '- Insufficient permissions, authentication failure',
      '- Parameter format error preventing tool execution',
      'Example: [ERROR] Inventory query tool call failed: connection timeout',
      '',
      '## Business Result Handling (Important — do NOT mark [ERROR])',
      'The following situations are **normal business results**; report them as-is without marking [ERROR]:',
      '- Query returns empty results (e.g. inventory is 0, no matching records found)',
      '- Queried entity does not exist (e.g. no inventory for a specific model, no price for a product)',
      '- Values are 0 or lists are empty',
      'Even if the result is "not found" or "quantity is 0", report the query results as-is.',
      'Let subsequent workflow steps decide how to handle them.',
      '',
      '## File Deliverables',
      // The literal executionId is embedded here so the LLM never has to
      // GUESS the execId path segment from the filename — that's how a
      // production SOP wound up with broken URLs (the LLM stripped the
      // `sop_` prefix because it looked like decoration). Tool results
      // now also carry a ready-made `download_url` field (see
      // lib/sop/llm-tool-executor.ts) — prefer copying that over
      // constructing your own.
      `If any tool returned a downloadable file the user should keep, you MUST include those URLs in your final answer as markdown links: \`[fileName](downloadUrl)\`. The current SOP execution id is \`${executionId}\` — when constructing URLs the path is \`/api/sop/${executionId}/files/<filename>\` (use this id VERBATIM, do not strip, abbreviate, or modify it). If the tool result already contains a \`download_url\` / \`downloadUrl\` field, copy it directly without rebuilding. Files you do NOT mention in the final answer are treated as intermediate artifacts and will be deleted after 30 days. If the task produced no files, answer normally and ignore this rule.`
    )

    const systemPrompt = systemPromptSections.join('\n') + getLanguageInstruction(snapshot)

    // userMessage: primarily node task description, with original request as background
    const taskDesc = node.description || node.name || 'Please execute the current task'
    const userMessage = originalUserMessage
      ? `${taskDesc}\n\nOriginal user request: ${originalUserMessage}`
      : taskDesc

    logger.info('[SOP Node] Prompt assembled, preparing to call LLM', {
      executionId,
      nodeId: node.id,
      nodeName: node.name,
      toolCount: tools.length,
      toolNames: tools.map((t) => t.function.name),
      systemPromptLength: systemPrompt.length,
      systemPromptPreview: systemPrompt.slice(0, 500),
      userMessage: userMessage.slice(0, 500),
    })

    // Execute LLM multi-round tool calls
    const employeeId = node.executorId

    // This node execution shares a single taskExecution, all tool call workLogs are attached to it
    // This way one SOP node execution = 1 task record, consistent with list page statistics granularity
    // On resume, reuse the suspended node's task so its journaled tool calls
    // (the rebuild key) stay attached to one task; only a fresh run creates one.
    const nodeTaskId = resume?.taskId ?? `task_${nanoid()}`
    // Measure from the node-execution row's start so a resumed run's duration
    // spans the whole node (including the async-tool suspend window), not just
    // the post-callback tail.
    const nodeTaskStart = nodeExecStartedAt.getTime()
    if (!resume) {
      try {
        await db.insert(taskExecutions).values({
          id: nodeTaskId,
          employeeId,
          sopExecutionId: executionId,
          triggerType: 'sop',
          status: 'running',
          input: { executionId, nodeId: node.id, nodeName: node.name },
          inputSummary: node.description || node.name || t('sopExecuteTask'),
          durationMs: 0,
          startedAt: new Date(),
        })
      } catch (e) {
        logger.warn('SOP node taskExecution creation failed', { error: e })
      }
    }

    // Started workLog intentionally not written: it duplicated the full node.description
    // (often 1–2 KB) without adding signal beyond what the completion log already provides.
    // Legacy rows in old executions are still tolerated by the reader-side filter in
    // buildHistoryFromWorkLogs and the i18n key remains defined in locale files.

    // Async tools mode: dispatch each round's tool calls and suspend the SOP
    // until their callbacks land. On resume the loop continues from the
    // conversation rebuilt out of work_logs.
    let result: LLMToolExecutionResult
    const asyncToolsMode = isAsyncToolsEnabled()
    if (asyncToolsMode) {
      let resumeMiddleMessages: Awaited<ReturnType<typeof rebuildNodeToolExchange>>['messages'] | undefined
      let startRound = 0
      if (resume) {
        const rebuilt = await rebuildNodeToolExchange(nodeTaskId)
        resumeMiddleMessages = rebuilt.messages
        startRound = rebuilt.lastRound + 1
      }
      const outcome = await runAsyncToolLoop({
        modelConfig,
        tools,
        toolEndpoints: endpointMap,
        systemPrompt,
        userMessage,
        maxRounds: 5,
        sopExecutionId: executionId,
        sopFileUrlPrefix,
        apiTools,
        identity: identityMeta,
        nodeId: node.id,
        taskId: nodeTaskId,
        employeeId,
        resumeMiddleMessages,
        startRound,
      })
      if (outcome.kind === 'suspended') {
        logger.info('[SOP Node] Suspended on async tool dispatch', {
          executionId,
          nodeId: node.id,
          round: outcome.round,
          dispatched: outcome.dispatched,
        })
        return { paused: true, pauseKind: 'tool', taskId: nodeTaskId }
      }
      // Done: map the loop outcome onto the shared post-processing path below.
      // Async tool results live in work_logs, not in-memory — reconstruct them so
      // downstream consumers (approval gate tool-usage check, completion log
      // counts) see which tools actually ran instead of an empty list.
      result = {
        summary: outcome.summary,
        toolResults: await loadNodeToolResults(nodeTaskId),
        rounds: outcome.rounds,
        totalTokens: outcome.totalTokens,
        error: outcome.error,
      }
    } else {
      result = await executeLLMWithTools({
      modelConfig,
      tools,
      toolEndpoints: endpointMap,
      systemPrompt,
      userMessage,
      maxRounds: 5,
      sopExecutionId: executionId,
      sopFileUrlPrefix,
      apiTools,
      identity: identityMeta,
      onToolResult: async (entry: ToolCallLogEntry) => {
        try {
          const displayName = entry.instanceName || entry.toolName
          const i18nKey = entry.success ? 'logWorkSopToolCallSuccess' : 'logWorkSopToolCallFailed'
          const content = entry.success
            ? t('sopToolCallSuccess', 'en', { name: displayName })
            : t('sopToolCallFailed', 'en', { name: displayName })
          await db.insert(workLogs).values({
            id: `log_${nanoid()}`,
            taskId: nodeTaskId,
            employeeId,
            logType: 'tool_call',
            content,
            metadata: {
              toolName: entry.toolName,
              toolId: entry.toolId,
              instanceName: entry.instanceName,
              round: entry.round,
              executionId,
              success: entry.success,
              input: entry.input,
              output: entry.output,
              i18nKey,
              i18nParams: { name: displayName },
            },
          })
        } catch (logErr) {
          logger.warn('SOP tool call log write failed', { error: logErr })
        }
      },
      })
    }

    // ── Execution layer fallback: check if all bound tools were called, auto-supplement uncalled ones ──
    // Skipped in async mode: tool results are journaled to work_logs, not held
    // in result.toolResults, so the "uncalled" detection would misfire.
    if (!asyncToolsMode && tools.length > 0 && !result.error) {
      const calledToolNames = new Set(result.toolResults.map((tr) => tr.toolName))
      const uncalledTools = tools.filter((t) => !calledToolNames.has(t.function.name))

      if (uncalledTools.length > 0) {
        logger.warn('[SOP Node] Detected uncalled tools, auto-supplementing', {
          executionId,
          nodeId: node.id,
          calledCount: calledToolNames.size,
          uncalledCount: uncalledTools.length,
          uncalledNames: uncalledTools.map((t) => t.function.name),
        })

        // Build supplement endpointMap (only uncalled tools)
        const supplementEndpointMap = new Map<string, ToolEndpointInfo>()
        for (const t of uncalledTools) {
          const ep = endpointMap.get(t.function.name)
          if (ep) supplementEndpointMap.set(t.function.name, ep)
        }

        const supplementPrompt =
          [
            `You are digital employee "${employeeName}", supplementing data retrieval.`,
            '',
            '## Background',
            `Current task is: ${node.description || node.name}`,
            '',
            '## Already Retrieved Data',
            result.summary ?? '(None)',
            '',
            '## Tools That Need Supplementary Calls',
            uncalledTools.map((t) => `- ${t.function.name}: ${t.function.description}`).join('\n'),
            '',
            `**You must call all ${uncalledTools.length} tools above to supplement the missing data.**`,
            'After completing all calls, combine existing data and supplementary data to provide a complete comprehensive summary.',
          ].join('\n') + getLanguageInstruction(snapshot)

        const supplementResult = await executeLLMWithTools({
          modelConfig,
          tools: uncalledTools,
          toolEndpoints: supplementEndpointMap,
          systemPrompt: supplementPrompt,
          userMessage: userMessage,
          maxRounds: 3,
          sopExecutionId: executionId,
          sopFileUrlPrefix,
          apiTools,
          identity: identityMeta,
          onToolResult: async (entry: ToolCallLogEntry) => {
            try {
              const displayName = entry.instanceName || entry.toolName
              const i18nKey = entry.success
                ? 'logWorkSopToolRetrySuccess'
                : 'logWorkSopToolRetryFailed'
              const content = entry.success
                ? t('sopToolRetrySuccess', 'en', { name: displayName })
                : t('sopToolRetryFailed', 'en', { name: displayName })
              await db.insert(workLogs).values({
                id: `log_${nanoid()}`,
                taskId: nodeTaskId,
                employeeId,
                logType: 'tool_call',
                content,
                metadata: {
                  toolName: entry.toolName,
                  toolId: entry.toolId,
                  instanceName: entry.instanceName,
                  round: entry.round,
                  executionId,
                  success: entry.success,
                  input: entry.input,
                  output: entry.output,
                  supplement: true,
                  i18nKey,
                  i18nParams: { name: displayName },
                },
              })
            } catch (logErr) {
              logger.warn('SOP supplement tool log write failed', { error: logErr })
            }
          },
        })

        logger.info('[SOP Node] Tool supplement completed', {
          executionId,
          nodeId: node.id,
          supplementToolCount: supplementResult.toolResults.length,
          supplementToolNames: supplementResult.toolResults.map((tr) => tr.toolName),
          supplementTokens: supplementResult.totalTokens,
        })

        // Merge supplement results into main results
        result.toolResults.push(...supplementResult.toolResults)
        result.totalTokens += supplementResult.totalTokens
        result.rounds += supplementResult.rounds
        // Replace original summary with supplement summary (supplement summary contains complete data)
        if (supplementResult.summary) {
          result.summary = supplementResult.summary
        }
        if (supplementResult.error) {
          result.error = supplementResult.error
        }
      }
    }

    logger.info('[SOP Node] LLM execution completed - aggregated results', {
      executionId,
      nodeId: node.id,
      nodeName: node.name,
      rounds: result.rounds,
      totalTokens: result.totalTokens,
      toolResultCount: result.toolResults.length,
      toolsCalled: result.toolResults.map((tr) => tr.toolName),
      toolCallDetails: result.toolResults.map((tr) => ({
        name: tr.toolName,
        round: tr.round,
        inputPreview: JSON.stringify(tr.input).slice(0, 200),
        outputPreview: JSON.stringify(tr.output).slice(0, 200),
      })),
      hasError: !!result.error,
      error: result.error ?? null,
      summaryLength: result.summary?.length ?? 0,
      summaryPreview: result.summary?.slice(0, 300) ?? null,
    })

    // Update taskExecution final status and duration
    try {
      await db
        .update(taskExecutions)
        .set({
          status: result.error ? 'failed' : 'success',
          durationMs: Date.now() - nodeTaskStart,
          outputSummary: result.summary?.slice(0, 200) ?? null,
          completedAt: new Date(),
        })
        .where(eq(taskExecutions.id, nodeTaskId))
    } catch (e) {
      logger.warn('SOP node taskExecution update failed', { error: e })
    }

    // Write action log for node completion
    try {
      const completionI18n = result.error
        ? { key: 'logWorkSopExecFailed', params: { error: result.error.slice(0, 500) } }
        : result.summary
          ? // Keep in sync with the `content` field below (1000 chars) so the
            // i18n re-render path stays consistent with what was originally written.
            { key: 'logWorkSopExecCompleted', params: { result: result.summary.slice(0, 1000) } }
          : { key: 'logWorkSopExecCompletedShort', params: {} }
      await db.insert(workLogs).values({
        id: `log_${nanoid()}`,
        taskId: nodeTaskId,
        employeeId,
        logType: result.error ? 'error' : 'action',
        content: result.error
          ? t('sopExecFailed', 'en', { error: result.error.slice(0, 500) })
          : result.summary
            ? // Raised 500 → 1000 so a full OCR-style JSON dump (~500-700 chars)
              // plus a short natural-language preamble fits without losing trailing
              // fields like amountInWords/expenseType/invoiceType.
              t('sopExecCompleted', 'en', { result: result.summary.slice(0, 1000) })
            : t('sopExecCompletedShort', 'en'),
        metadata: {
          executionId,
          nodeId: node.id,
          nodeName: node.name,
          durationMs: Date.now() - nodeTaskStart,
          i18nKey: completionI18n.key,
          i18nParams: completionI18n.params,
        },
      })
    } catch (logErr) {
      logger.warn('SOP node completion log write failed', { error: logErr })
    }

    // LLM self-judgment or fallback detected unrecoverable error — terminate SOP, do not continue
    if (result.error) {
      const errorMessage = result.error
      logger.warn('Digital employee node detected execution error, terminating SOP', {
        executionId,
        nodeId: node.id,
        error: errorMessage,
        summary: result.summary?.slice(0, 200),
      })

      await db
        .update(sopNodeExecutions)
        .set({
          status: 'error',
          errorMessage,
          result: {
            summary: result.summary,
            toolResults: result.toolResults,
            rounds: result.rounds,
            totalTokens: result.totalTokens,
          },
          completedAt: new Date(),
        })
        .where(eq(sopNodeExecutions.id, nodeExecId))

      // Mark as business error — engine should not retry, go to error exit or terminate directly
      return { error: errorMessage, errorExit: true }
    }

    const output: Record<string, unknown> = {
      summary: result.summary,
      toolResults: result.toolResults,
      rounds: result.rounds,
      totalTokens: result.totalTokens,
    }

    await db
      .update(sopNodeExecutions)
      .set({
        status: 'completed',
        result: output,
        completedAt: new Date(),
      })
      .where(eq(sopNodeExecutions.id, nodeExecId))

    return { output }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    logger.error('Digital employee LLM tool execution failed', {
      executionId,
      nodeId: node.id,
      error: errorMessage,
    })

    await db
      .update(sopNodeExecutions)
      .set({ status: 'error', errorMessage, completedAt: new Date() })
      .where(eq(sopNodeExecutions.id, nodeExecId))

    return { error: errorMessage }
  } finally {
    // Always tear down per-execution mounted-tool Pods, success or fail.
    if (deployedMountedTools.length > 0) {
      try {
        await cleanupMountedTools(deployedMountedTools, executionId)
      } catch (cleanupErr) {
        logger.warn('Mounted tool cleanup failed', {
          executionId,
          error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
        })
      }
    }
  }
}

/**
 * Reverse-lookup workspaceId from SOP execution record
 *
 * Exported for engine.ts approval pre-validation.
 * Finds the associated workflowId through workflow nodes in SOP definition,
 * then gets workspaceId from workflow table. Returns empty string when unavailable.
 */
export async function resolveWorkspaceIdFromExecution(executionId: string): Promise<string> {
  try {
    const [execution] = await db
      .select({ sopDefinitionId: sopExecutions.sopDefinitionId })
      .from(sopExecutions)
      .where(eq(sopExecutions.id, executionId))
      .limit(1)

    if (!execution || !execution.sopDefinitionId) return ''

    const [definition] = await db
      .select({ nodes: sopDefinitions.nodes })
      .from(sopDefinitions)
      .where(eq(sopDefinitions.id, execution.sopDefinitionId))
      .limit(1)

    if (!definition) return ''

    // Workflow canvas removed: the workspaceId previously resolved via
    // workflow.workspaceId is no longer available; callers fall back to
    // empty string and the approval layer handles it as unscoped.
    return ''
  } catch {
    return ''
  }
}

/**
 * Collaborator node executor — creates pause record, waits for collaborator to submit result via console
 */
async function executeHumanEmployeeNode(
  executionId: string,
  node: SopNode,
  snapshot: SopStateSnapshot
): Promise<NodeExecutionResult> {
  const nodeExecId = nanoid()
  const pauseId = `pause_${nanoid(16)}`

  await db.insert(sopNodeExecutions).values({
    id: nodeExecId,
    executionId,
    nodeId: node.id,
    nodeName: node.name,
    nodeType: node.type,
    status: 'running',
    startedAt: new Date(),
  })

  const expiresAt = node.timeoutMinutes
    ? new Date(Date.now() + node.timeoutMinutes * 60 * 1000)
    : undefined

  await db.insert(sopPauseStates).values({
    id: pauseId,
    executionId,
    nodeId: node.id,
    status: 'waiting',
    assigneeId: node.executorId,
    expiresAt,
  })

  // Inline generate approval token, write to sopPauseStates
  const { token } = await generateApprovalToken(pauseId)

  if (node.timeoutMinutes && node.timeoutMinutes > 0) {
    const timeoutQueue = getSopTimeoutQueue()
    if (timeoutQueue) {
      const job = await timeoutQueue.add(
        'sop-node-timeout',
        {
          executionId,
          nodeId: node.id,
          pauseId,
          type: 'node',
        },
        { delay: node.timeoutMinutes * 60 * 1000 }
      )

      await db
        .update(sopPauseStates)
        .set({ timeoutJobId: job.id })
        .where(eq(sopPauseStates.id, pauseId))
    }
  }

  // In sandbox mode, decide whether to send notifications based on policy
  if (isSandboxNotificationAllowed(snapshot)) {
    await enqueueNotification(executionId, node, pauseId, token, snapshot)
  } else {
    logger.info('Sandbox mode: skipping notification (policy.email=false)', {
      executionId,
      nodeId: node.id,
    })
  }

  logger.info('SOP paused for human employee', {
    executionId,
    nodeId: node.id,
    pauseId,
  })

  return { paused: true }
}

/**
 * Human confirm node executor — fixed 3 exits (approved/rejected/timeout)
 *
 * No longer pauses for approval, instead reads previous collaborator (human_employee)'s
 * approval result from snapshot, routes directly to the corresponding branch via exit conditions.
 */
async function executeHumanConfirmNode(
  executionId: string,
  node: SopNode,
  snapshot: SopStateSnapshot
): Promise<NodeExecutionResult> {
  const nodeExecId = nanoid()

  await db.insert(sopNodeExecutions).values({
    id: nodeExecId,
    executionId,
    nodeId: node.id,
    nodeName: node.name,
    nodeType: node.type,
    status: 'running',
    startedAt: new Date(),
  })

  // Find the most recent collaborator node's approval result from snapshot
  const previousDecision = findPreviousHumanDecision(snapshot)

  const decision = previousDecision?.decision ?? 'timeout'
  const comment = previousDecision?.comment

  logger.info('Human confirm node evaluating previous decision', {
    executionId,
    nodeId: node.id,
    decision,
  })

  // Record to exitDecisions for later traceability
  snapshot.exitDecisions[node.id] = {
    decision: decision as 'approved' | 'rejected',
    decidedBy: previousDecision?.decidedBy ?? 'system',
    decidedAt: new Date().toISOString(),
    comment,
  }

  await db
    .update(sopNodeExecutions)
    .set({
      status: 'completed',
      result: { decision, comment, source: 'previous_human_employee' },
      completedAt: new Date(),
    })
    .where(eq(sopNodeExecutions.id, nodeExecId))

  return { output: { decision, comment } }
}

/**
 * Reverse-search executionPath in snapshot for the most recent node with an approval decision
 */
function findPreviousHumanDecision(
  snapshot: SopStateSnapshot
): { decision: string; decidedBy: string; comment?: string } | null {
  // Reverse-iterate executed path to find the most recent approval decision
  for (let i = snapshot.executionPath.length - 1; i >= 0; i--) {
    const nodeId = snapshot.executionPath[i]
    const exitDecision = snapshot.exitDecisions[nodeId]
    if (exitDecision) {
      return {
        decision: exitDecision.decision,
        decidedBy: exitDecision.decidedBy,
        comment: exitDecision.comment,
      }
    }
  }
  return null
}

/**
 * Extract previous node execution result from snapshot (for notification email display)
 *
 * Prefer output of the most recent digital employee node (contains business data and tool results),
 * skip switch gateway nodes (their output contains routing metadata, unsuitable for display).
 */
async function extractPreviousNodeResult(
  snapshot: SopStateSnapshot,
  executionId?: string
): Promise<{
  previousNodeResult?: string
  previousNodeName?: string
}> {
  const path = snapshot.executionPath
  if (path.length === 0) return {}

  // Reverse-search for the most recent digital employee node (skip switch gateways)
  let prevNodeId: string | undefined
  for (let i = path.length - 1; i >= 0; i--) {
    const nodeId = path[i]
    const state = snapshot.nodeStates[nodeId]
    const output = state?.output ?? {}
    // switch node output contains _gatewayValue, skip
    if ('_gatewayValue' in output) continue
    prevNodeId = nodeId
    break
  }

  // Fallback: if all are switch nodes, take the last one
  if (!prevNodeId) {
    prevNodeId = path[path.length - 1]
  }

  const prevState = snapshot.nodeStates[prevNodeId]
  const wfResult = snapshot.workflowResults[prevNodeId]

  const rawOutput = wfResult?.output ?? prevState?.output
  if (!rawOutput || Object.keys(rawOutput).length === 0) return {}

  // Filter out internal metadata fields, keep only business data
  const output: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(rawOutput)) {
    if (
      !k.startsWith('_gateway') &&
      !k.startsWith('_supplement') &&
      k !== '_llmEvaluated' &&
      k !== '_supplemented' &&
      k !== '_insufficient'
    ) {
      output[k] = v
    }
  }

  if (Object.keys(output).length === 0) return {}

  // Look up previous node name (scoped to executionId, avoid getting stale data from other executions)
  const nodeExecRow = await db
    .select({ nodeName: sopNodeExecutions.nodeName })
    .from(sopNodeExecutions)
    .where(
      executionId
        ? and(
            eq(sopNodeExecutions.executionId, executionId),
            eq(sopNodeExecutions.nodeId, prevNodeId)
          )
        : eq(sopNodeExecutions.nodeId, prevNodeId)
    )
    .limit(1)
    .then((rows) => rows[0])

  try {
    return {
      previousNodeResult: JSON.stringify(output, null, 2),
      previousNodeName: nodeExecRow?.nodeName ?? prevNodeId,
    }
  } catch {
    return {}
  }
}

/**
 * Extract digital employee ID that triggered the conversation from snapshot triggerData._meta.employeeId
 *
 * SOPs triggered from conversation write this field in sop-bridge.ts.
 * Manual triggers or old data may lack this field, returns undefined (caller falls back to resolveSystemDefault).
 */
function extractSourceEmployeeId(snapshot: SopStateSnapshot): string | undefined {
  const meta = extractMeta(snapshot)
  return typeof meta?.employeeId === 'string' ? meta.employeeId : undefined
}

/**
 * Extract sender name from snapshot triggerData._meta.senderName
 */
function extractSenderName(snapshot: SopStateSnapshot): string | undefined {
  const meta = extractMeta(snapshot)
  return typeof meta?.senderName === 'string' ? meta.senderName : undefined
}

/**
 * Extract sender email from snapshot triggerData._meta.senderEmail
 */
function extractSenderEmail(snapshot: SopStateSnapshot): string | undefined {
  const meta = extractMeta(snapshot)
  return typeof meta?.senderEmail === 'string' ? meta.senderEmail : undefined
}

/**
 * Extract the requester's direct leader id from the injected caller identity
 * (snapshot triggerData._meta.identity.leaderId), for the 'requester_leader'
 * approver source.
 */
function extractLeaderId(snapshot: SopStateSnapshot): string | undefined {
  const meta = extractMeta(snapshot)
  const identity = meta?.identity as ScopeIdentity | undefined
  return identity?.leaderId
}

/**
 * Extract the trigger channel (e.g. 'feishu') from snapshot triggerData._meta.channel
 */
function extractRequesterChannel(snapshot: SopStateSnapshot): string | undefined {
  const meta = extractMeta(snapshot)
  return typeof meta?.channel === 'string' ? meta.channel : undefined
}

function extractMeta(snapshot: SopStateSnapshot): Record<string, unknown> | undefined {
  return (snapshot.triggerData as Record<string, unknown> | undefined)?._meta as
    | Record<string, unknown>
    | undefined
}

/**
 * Extract externally accessible baseUrl from snapshot triggerData._meta.baseUrl
 * Injected from request headers by API route when triggering SOP
 */
function extractBaseUrl(snapshot: SopStateSnapshot): string | undefined {
  const meta = extractMeta(snapshot)
  return typeof meta?.baseUrl === 'string' ? meta.baseUrl : undefined
}

/**
 * Extract user language from snapshot triggerData._meta.userLanguage
 * Injected by conversation engine when triggering SOP
 */
function extractUserLanguage(snapshot: SopStateSnapshot): string | undefined {
  const meta = extractMeta(snapshot)
  return typeof meta?.userLanguage === 'string' ? meta.userLanguage : undefined
}

/**
 * Generate LLM language instruction — append to system prompt end, ensure SOP internal LLM output follows user language
 */
function getLanguageInstruction(snapshot: SopStateSnapshot): string {
  const lang = extractUserLanguage(snapshot)
  if (!lang || lang === 'zh') return ''
  return '\n\n## Language Requirement\nYou MUST respond entirely in English. All output, summaries, and analysis must be in English.'
}

/**
 * Look up SOP name (for notification building)
 */
async function lookupSopName(executionId: string): Promise<string> {
  const execution = await db
    .select({ sopDefinitionId: sopExecutions.sopDefinitionId })
    .from(sopExecutions)
    .where(eq(sopExecutions.id, executionId))
    .then((rows) => rows[0])

  if (!execution || !execution.sopDefinitionId) return t('sopUnknown')

  const definition = await db
    .select({ name: sopDefinitions.name })
    .from(sopDefinitions)
    .where(eq(sopDefinitions.id, execution.sopDefinitionId))
    .then((rows) => rows[0])

  return definition?.name ?? 'Unknown SOP'
}

/**
 * Enqueue single notification (used by human_employee node)
 * Degrade to direct Worker call when Redis unavailable (ensure email delivery)
 */
async function enqueueNotification(
  executionId: string,
  node: SopNode,
  pauseId: string,
  approvalToken: string,
  snapshot: SopStateSnapshot
): Promise<void> {
  const approverSource = node.approverSource ?? 'assignee'
  const recipientId = node.executorId
  // In requester_leader mode, resolve the leader + channel from the injected
  // identity; executorId (if set) is the fallback approver.
  const leaderId = approverSource === 'requester_leader' ? extractLeaderId(snapshot) : undefined
  const requesterChannel =
    approverSource === 'requester_leader' ? extractRequesterChannel(snapshot) : undefined

  if (!recipientId && !leaderId) {
    logger.warn('enqueueNotification: no leader and no assignee to notify, skipping', {
      executionId,
      nodeId: node.id,
      approverSource,
    })
    return
  }

  const sopName = await lookupSopName(executionId)
  const prevResult = await extractPreviousNodeResult(snapshot, executionId)

  const employee = recipientId
    ? await db
        .select({ name: humanEmployees.name })
        .from(humanEmployees)
        .where(eq(humanEmployees.id, recipientId))
        .then((rows) => rows[0])
    : undefined

  // Extract digital employee ID, sender name, user language from triggerData._meta
  const sourceEmployeeId = extractSourceEmployeeId(snapshot)
  const senderName = extractSenderName(snapshot)
  const senderEmail = extractSenderEmail(snapshot)
  const baseUrl = extractBaseUrl(snapshot)
  const userLanguage = extractUserLanguage(snapshot)
  logger.info('Notification enqueued: sender info', {
    executionId,
    approverSource,
    hasLeaderId: !!leaderId,
    requesterChannel,
    senderName,
    senderEmail,
    sourceEmployeeId,
    baseUrl,
    userLanguage,
    hasTriggerData: !!snapshot.triggerData,
    metaKeys: snapshot.triggerData?._meta
      ? Object.keys(snapshot.triggerData._meta as Record<string, unknown>)
      : [],
  })

  const payload = {
    executionId,
    nodeId: node.id,
    recipientId: recipientId ?? '',
    recipientName: employee?.name ?? recipientId ?? '',
    approvalToken,
    messageTemplate: 'sop_approval_request',
    notifyMethod: node.notifyMethod,
    sourceEmployeeId,
    approverSource,
    contextData: {
      sopName,
      nodeName: node.name,
      pauseId,
      leaderId,
      requesterChannel,
      senderName,
      senderEmail,
      baseUrl,
      userLanguage,
      ...prevResult,
    },
  }

  await dispatchNotificationJob(payload, pauseId, recipientId ?? leaderId ?? 'leader')
}

/**
 * Enqueue multiple notifications (used by human_confirm node, one Job per approver)
 */
async function enqueueNotifications(
  executionId: string,
  node: SopNode,
  pauseId: string,
  approvalToken: string,
  approvers: string[],
  snapshot: SopStateSnapshot
): Promise<void> {
  if (approvers.length === 0) {
    logger.warn('enqueueNotifications: node has no configured approvers, skipping notification', {
      executionId,
      nodeId: node.id,
    })
    return
  }

  const sopName = await lookupSopName(executionId)
  const prevResult = await extractPreviousNodeResult(snapshot, executionId)
  const sourceEmployeeId = extractSourceEmployeeId(snapshot)
  const senderName = extractSenderName(snapshot)
  const senderEmail = extractSenderEmail(snapshot)
  const baseUrl = extractBaseUrl(snapshot)
  const userLanguage = extractUserLanguage(snapshot)

  for (const recipientId of approvers) {
    const employee = await db
      .select({ name: humanEmployees.name })
      .from(humanEmployees)
      .where(eq(humanEmployees.id, recipientId))
      .then((rows) => rows[0])

    const payload = {
      executionId,
      nodeId: node.id,
      recipientId,
      recipientName: employee?.name ?? recipientId,
      approvalToken,
      messageTemplate: 'sop_approval_request',
      sourceEmployeeId,
      contextData: {
        sopName,
        nodeName: node.name,
        pauseId,
        senderName,
        senderEmail,
        baseUrl,
        userLanguage,
        ...prevResult,
      },
    }

    await dispatchNotificationJob(payload, pauseId, recipientId)
  }
}

/**
 * Dispatch notification Job — BullMQ enqueue or direct Worker call
 */
async function dispatchNotificationJob(
  payload: import('@/types/sop').NotificationJobPayload,
  pauseId: string,
  recipientId: string
): Promise<void> {
  const queue = getSopNotificationQueue()
  if (queue) {
    await queue.add('notification', payload)
    logger.info('Notification enqueued (BullMQ)', { pauseId, recipientId })
  } else {
    logger.info('Redis unavailable, delivering notification directly', { pauseId, recipientId })
    import('./workers/notification-worker')
      .then(({ processNotification }) => processNotification(payload))
      .catch((err: unknown) =>
        logger.error('Direct notification delivery failed', {
          pauseId,
          error: (err as Error).message,
        })
      )
  }
}
