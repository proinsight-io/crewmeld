/**
 * SOP bridge — trigger SOP execution from conversation
 *
 * Execution strategy: with timeout wait
 * - Wait up to SOP_WAIT_TIMEOUT_MS ms after starting SOP engine
 * - If completed within timeout -> return actual execution results (e.g. generated SQL, data)
 * - If paused for human confirmation or not completed -> return "started" + executionId
 */

import {
  conversationMessages,
  conversations,
  db,
  sopDefinitions,
  sopExecutions,
  user,
} from '@crewmeld/db'
import { createLogger } from '@crewmeld/logger'
import { and, desc, eq } from 'drizzle-orm'
import { generateExecutionId } from '@/lib/core/execution-id'
import { t } from '@/lib/core/server-i18n'
import { getBaseUrl } from '@/lib/core/utils/urls'
import { executeSop, transitionStatus } from '@/lib/sop/engine'
import { processDeliverables } from '@/lib/sop/deliverables'
import {
  type ConversationAttachment,
  copyConversationFilesToSopInputs,
} from '@/lib/sop/file-workspace'
import {
  allocateSopFiles,
  seedFromConversationIoToSopFiles,
} from '@/lib/sop/sop-files-workspace'
import { getSopTimeoutQueue } from '@/lib/sop/queue'
import { validateSopForExecution } from '@/lib/sop/validator'
import type { SopNode, SopSerializedEdge, SopStateSnapshot } from '@/types/sop'
import { notifyChannelOnSopCompletion } from './sop-completion-notifier'

const logger = createLogger('SopBridge')

/** SOP execution wait timeout (ms) — LLM Agent multi-tool calls require longer time */
const SOP_WAIT_TIMEOUT_MS = 180_000

/** Polling interval (ms) */
const POLL_INTERVAL_MS = 500

export interface SopBridgeResult {
  success: boolean
  executionId: string
  sopName: string
  /** Whether final result is obtained (completed/failed/error), false means still executing async */
  completed: boolean
  /** Output summary when execution completes */
  output?: string
  /** Attachments produced during execution (from tool-returned files field) */
  files?: Array<{ name: string; mimeType: string; base64: string }>
  /**
   * Attachments produced by mounted (needsFileMount) tools and copied
   * from sop/{execId}/outputs/ into the conversation's persistent
   * prefix. The keys here are conversation-scoped (long-lived), suitable
   * for storing in conversationMessages.metadata.files.
   */
  workspaceFiles?: ConversationAttachment[]
  errorMessage?: string
}

/**
 * Trigger SOP execution from conversation
 *
 * 1. Validate SOP definition exists and is active
 * 2. Write to sop_executions (pending)
 * 3. Transition status -> running
 * 4. Start SOP engine and wait for completion (with timeout)
 * 5. Return execution result or async status
 */
export async function executeSopFromConversation(
  conversationId: string,
  employeeId: string,
  sopDefinitionId: string,
  triggerData: Record<string, unknown>,
  userId: string,
  onProgress?: (message: string) => void,
  isZh = true
): Promise<SopBridgeResult> {
  const executionId = generateExecutionId('sop')

  // 1. Query SOP definition (with nodes/edges, for checking collaborator nodes + pre-execution validation)
  const [sopDef] = await db
    .select({
      id: sopDefinitions.id,
      name: sopDefinitions.name,
      version: sopDefinitions.version,
      nodes: sopDefinitions.nodes,
      edges: sopDefinitions.edges,
      sopTimeoutMinutes: sopDefinitions.sopTimeoutMinutes,
    })
    .from(sopDefinitions)
    .where(and(eq(sopDefinitions.id, sopDefinitionId), eq(sopDefinitions.isActive, true)))
    .limit(1)

  if (!sopDef) {
    return {
      success: false,
      executionId,
      sopName: '',
      completed: false,
      errorMessage: `SOP definition ${sopDefinitionId} not found or inactive`,
    }
  }

  // Pre-execution validation
  const validation = await validateSopForExecution(
    (sopDef.nodes ?? []) as SopNode[],
    (sopDef.edges ?? []) as SopSerializedEdge[]
  )
  if (!validation.valid) {
    const errorMessages = validation.errors.map((e) => `"${e.nodeName}" ${e.message}`).join('; ')
    return {
      success: false,
      executionId,
      sopName: sopDef.name,
      completed: false,
      errorMessage: `SOP validation failed: ${errorMessages}`,
    }
  }

  try {
    // 2. Write execution record
    //    Store metadata separately from user params, avoid polluting workflow input with source/conversationId/employeeId
    //    senderName read from conversation metadata (written async by webhook)
    const [convRow] = await db
      .select({ metadata: conversations.metadata, channel: conversations.channel })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1)
    let senderName = (convRow?.metadata as Record<string, unknown>)?.senderName as
      | string
      | undefined
    const channel = convRow?.channel ?? undefined

    // Fallback: when no senderName in metadata (historical conversation), lookup from user table
    if (!senderName && userId) {
      const [userRow] = await db
        .select({ name: user.name })
        .from(user)
        .where(eq(user.id, userId))
        .limit(1)
      senderName = userRow?.name ?? undefined
    }
    logger.info('SOP bridge: reading sender name', {
      conversationId,
      senderName,
      metadata: convRow?.metadata,
    })

    // Try to get baseUrl for approval notification link construction
    let baseUrl: string | undefined
    try {
      baseUrl = getBaseUrl()
    } catch {
      /* non-critical path, ignore */
    }

    await db.insert(sopExecutions).values({
      id: executionId,
      sopDefinitionId: sopDef.id,
      sopVersion: sopDef.version,
      triggeredBy: userId,
      status: 'pending',
      triggerData: {
        _meta: {
          source: 'conversation',
          conversationId,
          employeeId,
          senderName,
          senderEmail: userId,
          userId,
          channel,
          baseUrl,
          userLanguage: isZh ? 'zh' : 'en',
        },
        ...triggerData,
      },
    })

    // Pre-create the NFS sop-files dir unconditionally — tools may write
    // outputs even when no input file was uploaded (e.g. report generators
    // that take JSON params, produce a PDF). Failure here is non-fatal and
    // gets logged below in the same catch block as the seed.
    try {
      await allocateSopFiles(executionId)
    } catch (err) {
      logger.warn('Failed to allocate sop-files dir', {
        executionId,
        error: err instanceof Error ? err.message : String(err),
      })
    }

    // Copy attachments from the most recent user message into the SOP
    // workspace so mounted tools see them at /workspace/inputs/{name}.
    // Best-effort: a copy failure logs a warning but does not block
    // execution — tools that don't read attachments are unaffected.
    try {
      const [lastUserMsg] = await db
        .select({ metadata: conversationMessages.metadata })
        .from(conversationMessages)
        .where(
          and(
            eq(conversationMessages.conversationId, conversationId),
            eq(conversationMessages.role, 'user')
          )
        )
        .orderBy(desc(conversationMessages.createdAt))
        .limit(1)
      const meta = lastUserMsg?.metadata as Record<string, unknown> | undefined
      const files = meta?.files as
        | Array<{ key: string; name: string; size: number; mimeType: string }>
        | undefined
      if (files && files.length > 0) {
        // Legacy MinIO seed — feeds the rclone sidecar attached to K8s
        // tools with needsFileMount=true (lib/k8s/deploy-skill.ts buildDeployment).
        await copyConversationFilesToSopInputs(conversationId, files, executionId)
      }
      // NFS conv-io → NFS sop-files seed for dev-studio tools (kind=service
      // deploy or kind=script ephemeral). Runs unconditionally — even when
      // the most recent user message has no attachments, the conversation
      // may still have files staged via the direct conv-io upload route or
      // earlier chat dual-writes. The function no-ops if the source dir is
      // empty. Mirrors the dev-studio test flow's session-io → sop-files
      // copy in lib/dev-studio/io-sync.ts.
      const [convRow] = await db
        .select({ createdAt: conversations.createdAt })
        .from(conversations)
        .where(eq(conversations.id, conversationId))
        .limit(1)
      if (convRow) {
        await seedFromConversationIoToSopFiles(
          conversationId,
          convRow.createdAt,
          executionId
        )
      }
    } catch (copyErr) {
      logger.warn('Failed to seed SOP inputs from conversation', {
        conversationId,
        executionId,
        error: copyErr instanceof Error ? copyErr.message : String(copyErr),
      })
    }

    // 2b. Register SOP-level timeout job (non-blocking, must not prevent execution)
    try {
      const timeoutQueue = getSopTimeoutQueue()
      if (timeoutQueue && sopDef.sopTimeoutMinutes > 0) {
        await timeoutQueue.add(
          'sop-timeout',
          {
            executionId,
            type: 'sop',
          },
          { delay: sopDef.sopTimeoutMinutes * 60 * 1000 }
        )
      }
    } catch (e) {
      logger.warn('Failed to register SOP timeout job, execution will proceed without timeout', {
        executionId,
        error: (e as Error).message,
      })
    }

    // 3. pending → running
    const transitioned = await transitionStatus(executionId, 'pending', 'running', {
      startedAt: new Date(),
    })

    if (!transitioned) {
      return {
        success: false,
        executionId,
        sopName: sopDef.name,
        completed: false,
        errorMessage: 'SOP status transition failed',
      }
    }

    // 4. Start SOP engine (do not await, but track Promise)
    const sopPromise = executeSop(executionId).catch((error) => {
      logger.error(`SOP execution error: ${executionId}`, error)
    })

    // Check if SOP contains collaborator nodes (human_employee / human_confirm)
    const sopNodes = (sopDef.nodes ?? []) as Array<{ type: string }>
    const hasCollaborator = sopNodes.some(
      (n) => n.type === 'human_employee' || n.type === 'human_confirm'
    )

    logger.info(
      `SOP triggered: execution=${executionId}, sop=${sopDef.name}, conversation=${conversationId}, hasCollaborator=${hasCollaborator}`
    )

    // 5. Wait for SOP completion or timeout
    //    Has collaborator -> return immediately on paused_for_human
    //    No collaborator -> wait up to 180 seconds
    const result = await waitForCompletion(
      executionId,
      sopPromise,
      onProgress,
      hasCollaborator,
      isZh
    )

    if (result.completed) {
      logger.info(`SOP completed synchronously: execution=${executionId}, status=${result.status}`)

      // End-of-SOP deliverables flow (success path only):
      // Extract any /api/sop/{execId}/files/... URLs the LLM included in
      // the final message, copy those files into conversations/{convId}/,
      // and rewrite the URLs to point at the long-lived conversation proxy.
      // Pure MinIO operation — the tool pods already pushed their outputs
      // to MinIO sop/{execId}/ in the per-call sync. BFF never touches PVC.
      let workspaceFiles: ConversationAttachment[] | undefined
      let finalOutput = result.output
      if (result.status === 'completed') {
        try {
          const deliverables = await processDeliverables({
            sopExecutionId: executionId,
            conversationId,
            finalMessage: result.output ?? '',
          })
          if (deliverables.attachments.length > 0) {
            workspaceFiles = deliverables.attachments
          }
          finalOutput = deliverables.message
        } catch (err) {
          logger.warn('SOP deliverables processing failed', {
            executionId,
            conversationId,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }

      return {
        success: result.status === 'completed',
        executionId,
        sopName: sopDef.name,
        completed: true,
        output: finalOutput,
        files: result.files,
        workspaceFiles,
        errorMessage: result.status !== 'completed' ? result.errorMessage : undefined,
      }
    }

    // Timeout or paused — return async status, register completion callback
    logger.info(
      `SOP executing asynchronously: execution=${executionId}, currentStatus=${result.status}`
    )

    // When SOP finally completes, async push results to IM channels (Feishu/WeCom)
    sopPromise
      .then(async () => {
        const finalResult = await queryExecutionResult(executionId)
        if (finalResult.completed) {
          // Mirror the sync path's deliverables flow so the notifier sees
          // long-lived URLs. Tool pods already pushed outputs to MinIO via
          // their per-call sync; BFF only does the MinIO CopyObject step.
          let workspaceFiles: ConversationAttachment[] | undefined
          let notifyOutput = finalResult.output
          if (finalResult.status === 'completed') {
            try {
              const deliverables = await processDeliverables({
                sopExecutionId: executionId,
                conversationId,
                finalMessage: finalResult.output ?? '',
              })
              if (deliverables.attachments.length > 0) {
                workspaceFiles = deliverables.attachments
              }
              notifyOutput = deliverables.message
            } catch (err) {
              logger.warn('SOP deliverables processing failed (async)', {
                executionId,
                conversationId,
                error: err instanceof Error ? err.message : String(err),
              })
            }
          }

          await notifyChannelOnSopCompletion({
            conversationId,
            sopName: sopDef.name,
            executionId,
            output: notifyOutput,
            files: finalResult.files,
            workspaceFiles,
            errorMessage: finalResult.errorMessage,
            status: finalResult.status as 'completed' | 'failed' | 'error',
          })
        }
      })
      .catch((error) => {
        logger.error(`SOP completion callback error: ${executionId}`, error)
      })

    return {
      success: true,
      executionId,
      sopName: sopDef.name,
      completed: false,
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    logger.error(`SOP bridge error: ${executionId}`, error)

    return {
      success: false,
      executionId,
      sopName: sopDef.name,
      completed: false,
      errorMessage,
    }
  }
}

interface FileAttachment {
  name: string
  mimeType: string
  base64: string
}

interface WaitResult {
  completed: boolean
  status: string
  output?: string
  files?: FileAttachment[]
  errorMessage?: string
}

/** Progress push interval (ms) — no need to push every 500ms, once per 3s is sufficient */
const PROGRESS_INTERVAL_MS = 3_000

/**
 * Wait for SOP execution completion (with timeout + progress push)
 *
 * Strategy: poll SOP execution status while pushing step progress to frontend.
 * End waiting if sopPromise completes first or timeout is reached.
 */
async function waitForCompletion(
  executionId: string,
  sopPromise: Promise<void>,
  onProgress?: (message: string) => void,
  hasCollaborator?: boolean,
  isZh = true
): Promise<WaitResult> {
  let done = false
  let lastProgressTime = 0
  let lastProgressMsg = ''

  // Listen for sopPromise completion
  sopPromise
    .then(() => {
      done = true
    })
    .catch(() => {
      done = true
    })

  const startTime = Date.now()

  while (!done && Date.now() - startTime < SOP_WAIT_TIMEOUT_MS) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))

    // Check if terminal state reached
    const current = await queryExecutionResult(executionId)
    if (current.completed) {
      return current
    }

    // SOP with collaborators: return immediately on detecting pause for human confirmation, stop waiting
    if (hasCollaborator && current.status === 'paused_for_human') {
      logger.info(
        `SOP entered human confirmation phase, returning immediately: execution=${executionId}`
      )
      return { completed: false, status: current.status }
    }

    // Push step progress (once every PROGRESS_INTERVAL_MS)
    if (onProgress && Date.now() - lastProgressTime >= PROGRESS_INTERVAL_MS) {
      const progressMsg = buildSopProgressMessage(current.status, executionId, isZh)
      if (progressMsg && progressMsg !== lastProgressMsg) {
        onProgress(progressMsg)
        lastProgressMsg = progressMsg
      }
      lastProgressTime = Date.now()
    }
  }

  // Final check
  if (done) {
    return queryExecutionResult(executionId)
  }

  // Timeout
  const current = await queryExecutionResult(executionId)
  if (current.completed) {
    return current
  }

  return { completed: false, status: current.status }
}

/**
 * Build progress hint text based on SOP execution status
 */
function buildSopProgressMessage(status: string, _executionId: string, isZh = true): string | null {
  switch (status) {
    case 'running':
      return t('taskRunning', isZh ? 'zh' : 'en')
    case 'paused':
      return t('taskAwaitingConfirmation', isZh ? 'zh' : 'en')
    case 'pending':
      return t('taskQueued', isZh ? 'zh' : 'en')
    default:
      return null
  }
}

/**
 * Query SOP execution final result
 */
async function queryExecutionResult(executionId: string): Promise<WaitResult> {
  const [exec] = await db
    .select({
      status: sopExecutions.status,
      stateSnapshot: sopExecutions.stateSnapshot,
      errorMessage: sopExecutions.errorMessage,
    })
    .from(sopExecutions)
    .where(eq(sopExecutions.id, executionId))
    .limit(1)

  if (!exec) {
    return { completed: true, status: 'error', errorMessage: 'Execution record not found' }
  }

  const terminalStatuses = ['completed', 'failed', 'timed_out', 'cancelled', 'error']
  const isTerminal = terminalStatuses.includes(exec.status)

  if (!isTerminal) {
    return { completed: false, status: exec.status }
  }

  // Extract final output and attachments from stateSnapshot
  const snapshot = exec.stateSnapshot as unknown as SopStateSnapshot
  const output = extractOutputFromSnapshot(snapshot)
  const files = extractFilesFromSnapshot(snapshot)

  return {
    completed: true,
    status: exec.status,
    output,
    files: files.length > 0 ? files : undefined,
    errorMessage: exec.errorMessage ?? undefined,
  }
}

/**
 * Extract execution output summary from state snapshot
 *
 * Iterate completed node outputs in executionPath, concatenate into readable text.
 */
function extractOutputFromSnapshot(snapshot: SopStateSnapshot | null): string | undefined {
  if (!snapshot) return undefined

  const outputs: string[] = []

  // Extract each node output in execution path order
  for (const nodeId of snapshot.executionPath) {
    const nodeState = snapshot.nodeStates[nodeId]
    if (nodeState?.status === 'completed' && nodeState.output) {
      const outputStr = formatNodeOutput(nodeState.output)
      if (outputStr) {
        outputs.push(outputStr)
      }
    }
  }

  // Also check workflowResults
  for (const [_wfId, wfResult] of Object.entries(snapshot.workflowResults ?? {})) {
    if (wfResult && typeof wfResult === 'object') {
      const outputStr = formatNodeOutput(wfResult as unknown as Record<string, unknown>)
      if (outputStr) {
        outputs.push(outputStr)
      }
    }
  }

  if (outputs.length === 0) return undefined

  // Deduplicate and merge
  const unique = [...new Set(outputs)]
  return unique.join('\n')
}

/**
 * Format single node output to readable string
 */
function formatNodeOutput(output: Record<string, unknown>): string | undefined {
  if (!output || Object.keys(output).length === 0) return undefined

  // If output has common fields like result / output / content / text / sql, prefer those
  for (const key of ['result', 'output', 'content', 'text', 'sql', 'summary', 'response']) {
    if (output[key] && typeof output[key] === 'string') {
      return output[key] as string
    }
  }

  // Otherwise JSON serialize
  try {
    return JSON.stringify(output, null, 2)
  } catch {
    return undefined
  }
}

/**
 * Extract all attachments from all node outputs in state snapshot
 *
 * Tool execution results stored in nodeState.output.toolResults[].output,
 * extract if tool returned a files field.
 */
function extractFilesFromSnapshot(snapshot: SopStateSnapshot | null): FileAttachment[] {
  if (!snapshot) return []

  const files: FileAttachment[] = []

  for (const nodeId of snapshot.executionPath) {
    const nodeState = snapshot.nodeStates[nodeId]
    if (nodeState?.status !== 'completed' || !nodeState.output) continue

    // toolResults from LLM tool execution results
    const toolResults = nodeState.output.toolResults as
      | Array<{
          output?: unknown
        }>
      | undefined

    if (!Array.isArray(toolResults)) continue

    for (const tr of toolResults) {
      const output = tr.output as Record<string, unknown> | null
      if (!output) continue

      // Tool directly returned files field
      const resultFiles = output.files as
        | Array<{ name: string; mimeType: string; base64: string }>
        | undefined
      if (Array.isArray(resultFiles)) {
        for (const f of resultFiles) {
          if (f.name && f.base64) {
            files.push({
              name: f.name,
              mimeType: f.mimeType ?? 'application/octet-stream',
              base64: f.base64,
            })
          }
        }
      }
    }
  }

  return files
}
