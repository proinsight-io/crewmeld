/**
 * Conversation engine — core message loop, self-built OpenAI-compatible API calls
 *
 * Flow:
 * 1. Load conversation + employee -> build system prompt -> build context window
 * 2. Resolve model credentials -> build tools
 * 3. fetch() OpenAI-compatible /chat/completions (stream: true)
 * 4. Parse SSE response, detect tool_calls
 * 5. tool_call matches wf_* -> call workflow-bridge
 * 5b. tool_call matches sop_* -> call sop-bridge (non-blocking)
 * 6. Inject tool result into messages, re-call LLM
 * 7. Loop until plain text -> stream output to frontend
 */

/**
 * work_logs.content i18n strategy (decided in plan T11):
 *   consumed only by UI — all read paths (employees/[id]/logs, tasks/[id]/logs) are API
 *   routes that return JSON to the frontend; no code path reads work_logs.content back
 *   into the LLM messages array or any prompt string.
 *
 * Therefore: content field rendered in 'en' (T12 will switch lang→'en' + add metadata.i18nKey)
 */

import {
  conversationMessages,
  conversations,
  db,
  digitalEmployees,
  sopExecutions,
  taskExecutions,
  workLogs,
} from '@crewmeld/db'
import { createLogger } from '@crewmeld/logger'
import { and, eq, sql } from 'drizzle-orm'
import { detect } from 'tinyld'
import { v4 as uuidv4 } from 'uuid'
import { CodedError } from '@/lib/core/errors'
import { t } from '@/lib/core/server-i18n'
import { encodeSSE } from '@/lib/core/utils/sse'
import { makeLogMetadata } from '@/lib/i18n/log-payload'
import { resolveChannelIdentity } from '@/lib/identity/channel-identity'
import type { ScopeIdentity } from '@/lib/identity/types'
import { resolveWebIdentity } from '@/lib/identity/web-identity'
import { buildContextWindow, stripToolStructureFromHistory } from './context'
import { classifyIntent } from './intent-classifier'
import { buildWorkflowToolConfigs } from './intent-router'
import { getEmployeeKnowledgeBaseIds, queryEmployeeKnowledge } from './knowledge-query'
import { resolveModelConfig } from './model-config'
import { buildSystemPrompt } from './persona'
import { executeSopFromConversation } from './sop-bridge'
import type {
  ChatCompletionChunk,
  ConversationEvent,
  EngineMessage,
  KnowledgeChunkReference,
  OpenAITool,
  ToolCall,
} from './types'

async function executeWorkflowFromConversation(
  _conversationId: string,
  _employeeId: string,
  _workflowId: string,
  _args: Record<string, unknown>,
  _userId: string,
  _workspaceId: string
): Promise<{ success: boolean; outputSummary?: string; errorMessage?: string }> {
  return { success: false, errorMessage: 'Workflow execution is not supported in this version.' }
}

import { logModelUsage } from '@/lib/models/usage-logger'
import { type FileAttachment, uploadConversationFile } from './file-storage'
import { querySopExecutionStatus } from './sop-status'
import { queryUserTasks, type TaskFilter } from './task-query'

const logger = createLogger('ConversationEngine')

const MAX_TOOL_ROUNDS = 5

/**
 * Process user message — returns SSE stream
 * @param preferredLocale - Optional locale hint from frontend (e.g. 'zh-CN' or 'en'),
 *   used when auto-detection is inconclusive. Does NOT override a clearly detected language.
 */
export async function processMessage(
  conversationId: string,
  userMessage: string,
  userId: string,
  /** Files attached to user message (uploaded to MinIO, written to metadata.files) */
  fileMetadata?: Array<{ key: string; name: string; size: number; mimeType: string }>,
  /** Frontend locale preference, used as fallback when auto-detection is inconclusive */
  preferredLocale?: string,
  /** Credentials of the connection that received the message (IM webhooks), threaded to SOP identity resolution so it uses the correct app — not a system default. */
  channelConfig?: Record<string, unknown>,
  /** Id of the channel connection that received the message; null/undefined for web/api. */
  connectionId?: string
): Promise<ReadableStream<Uint8Array>> {
  // 1. Load conversation
  const [conv] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1)

  if (!conv) {
    throw new CodedError('CONVERSATION_NOT_FOUND', t('conversationNotFound'))
  }

  if (conv.status !== 'active') {
    // Auto-reactivate closed conversations when channel messages arrive
    if (conv.status === 'closed' || conv.status === 'archived') {
      await db
        .update(conversations)
        .set({ status: 'active', updatedAt: new Date() })
        .where(eq(conversations.id, conversationId))
      logger.info('Conversation reactivated', { conversationId, previousStatus: conv.status })
    } else {
      throw new CodedError('CONVERSATION_CLOSED', t('conversationClosed'))
    }
  }

  // 2. Load employee
  const [employee] = await db
    .select({
      id: digitalEmployees.id,
      name: digitalEmployees.name,
      description: digitalEmployees.description,
      persona: digitalEmployees.persona,
    })
    .from(digitalEmployees)
    .where(eq(digitalEmployees.id, conv.employeeId))
    .limit(1)

  if (!employee) {
    throw new Error(t('employeeNotFound'))
  }

  // 3. Save user message, use first message as title if conversation has no title
  //    Append attachment info as structured annotations to message end, for LLM / SOP tools to identify files
  const userMsgId = uuidv4()
  // File-only without text content: short-circuit by replying to ask for requirements, skip intent classification and SOP
  // Channel plugins may auto-compose "用户发送了文件「xxx」" as placeholder, also treated as no user requirement
  const fileOnlyPlaceholder = /^(\[User sent a file:\s.+?\];?\s*)+$/i
  const hasFileOnly =
    fileMetadata &&
    fileMetadata.length > 0 &&
    (!userMessage.trim() || fileOnlyPlaceholder.test(userMessage.trim()))
  let contentForLLM = userMessage
  if (fileMetadata && fileMetadata.length > 0) {
    // Unified file IO contract (spec 2026-06-01): files are pre-staged on
    // NFS at `/root/io/<_sopFileDir>/<name>` before any tool runs.
    //
    // Emit ONLY the filename — no URL — so the LLM passes a bare name that
    // the tool joins onto its `/root/io/<_sopFileDir>/` mount. Telling the
    // LLM a URL here caused it to pass the URL as `pdf_file`, which the
    // tool then concatenated into `/root/io/<dir>/<URL>` → FileNotFoundError.
    //
    // The name must match the **on-disk filename** in conv-io (sanitized at
    // upload time in file-storage.ts:67 — `[^a-zA-Z0-9._\-CJK]` → `_`).
    // FileAttachment.name keeps the original user-facing name for the chat
    // UI; we re-apply the same regex here so the LLM tells the tool the
    // exact filesystem name.
    const sanitizeForNfs = (name: string): string =>
      name.replace(/[^a-zA-Z0-9._\-一-鿿]/g, '_')
    const fileAnnotations = fileMetadata.map((f) => {
      const safeName = sanitizeForNfs(f.name)
      return `[附件: name=${safeName}, mimeType=${f.mimeType}, size=${f.size}]`
    })
    contentForLLM = `${userMessage}\n\n${fileAnnotations.join('\n')}`
  }
  await db.insert(conversationMessages).values({
    id: userMsgId,
    conversationId,
    role: 'user',
    content: contentForLLM,
    metadata: fileMetadata && fileMetadata.length > 0 ? { files: fileMetadata } : undefined,
  })

  if (!conv.title) {
    await db
      .update(conversations)
      .set({ title: userMessage.slice(0, 50) })
      .where(eq(conversations.id, conversationId))
  }

  // 4. Load message history
  const historyRows = await db
    .select({
      role: conversationMessages.role,
      content: conversationMessages.content,
      toolCalls: conversationMessages.toolCalls,
      toolCallId: conversationMessages.toolCallId,
      toolName: conversationMessages.toolName,
      createdAt: conversationMessages.createdAt,
    })
    .from(conversationMessages)
    .where(eq(conversationMessages.conversationId, conversationId))
    .orderBy(conversationMessages.createdAt)

  // Expire tool interactions older than 5 minutes, prevent LLM from reusing stale data and skipping tool calls
  // Need to expire three message types: assistant(tool_calls) -> tool(result) -> assistant(result-based reply)
  // Use database time as baseline, avoid JS/DB timezone inconsistency
  const [{ dbNow }] = await db.execute<{ dbNow: Date }>(sql`SELECT NOW() as "dbNow"`)
  const dbNowMs = new Date(dbNow).getTime()
  const TOOL_RESULT_EXPIRE_MS = 5 * 60 * 1000
  const EXPIRED_HINT = t('expiredHint', 'zh')

  // Step 1: mark which tool_call_ids are expired
  const expiredToolCallIds = new Set<string>()
  for (const row of historyRows) {
    if (row.role === 'tool' && row.toolCallId && row.createdAt) {
      const age = dbNowMs - new Date(row.createdAt).getTime()
      if (age > TOOL_RESULT_EXPIRE_MS) {
        expiredToolCallIds.add(row.toolCallId)
      }
    }
  }

  // Step 2: build history messages, replace all expired tool interaction chains
  const rawMessages: EngineMessage[] = historyRows.map((row) => {
    // tool message expired -> replace content
    if (row.role === 'tool' && row.toolCallId && expiredToolCallIds.has(row.toolCallId)) {
      return {
        role: row.role as EngineMessage['role'],
        content: EXPIRED_HINT,
        tool_call_id: row.toolCallId,
        name: row.toolName ?? undefined,
      }
    }
    // assistant with tool_calls and all calls expired -> preserve tool_calls structure but mark
    if (row.role === 'assistant' && row.toolCalls) {
      const calls = row.toolCalls as ToolCall[]
      const allExpired = calls.length > 0 && calls.every((tc) => expiredToolCallIds.has(tc.id))
      if (allExpired) {
        return {
          role: row.role as EngineMessage['role'],
          content: EXPIRED_HINT,
          tool_calls: calls,
        }
      }
    }
    return {
      role: row.role as EngineMessage['role'],
      content: row.content,
      tool_calls: row.toolCalls as ToolCall[] | undefined,
      tool_call_id: row.toolCallId ?? undefined,
      name: row.toolName ?? undefined,
    }
  })

  // Step 3: expire assistant plain text replies (summaries based on tool results) following expired tool chains
  // Message order: ... -> assistant(tool_calls) -> tool(result) -> assistant(summary) -> ...
  const expiredMessages: EngineMessage[] = rawMessages.map((msg, i) => {
    if (
      msg.role === 'assistant' &&
      !msg.tool_calls &&
      msg.content &&
      msg.content !== EXPIRED_HINT
    ) {
      // Look backward: if the preceding message is an expired tool message, current assistant is also a summary based on expired data
      for (let j = i - 1; j >= 0; j--) {
        const prev = rawMessages[j]
        if (prev.role === 'tool' && prev.content === EXPIRED_HINT) {
          return { ...msg, content: EXPIRED_HINT }
        }
        // Skip consecutive tool messages (multi-tool call scenario)
        if (prev.role !== 'tool') break
      }
    }
    return msg
  })

  // Step 4: strip raw tool-call structure (assistant tool_calls + tool results)
  // from the history sent to the LLM. The expiry above already neutralised stale
  // summaries (so the model still re-invokes tools when data is old); this only
  // removes the structural tool-call payloads that would otherwise prime the
  // model to echo a tool call — e.g. a permission-filtered SOP — back to the
  // user as raw JSON. DB persistence and the UI (which read conversation_messages
  // directly) are unaffected.
  const historyMessages: EngineMessage[] = stripToolStructureFromHistory(expiredMessages)

  // Language detection — completed before entering stream, for progress text and system prompt
  const LANGUAGE_LABELS: Record<string, string> = {
    zh: '简体中文',
    en: 'English',
    ja: '日本語',
    ko: '한국어',
    fr: 'Français',
    de: 'Deutsch',
    es: 'Español',
    pt: 'Português',
    ru: 'Русский',
    ar: 'العربية',
    th: 'ไทย',
    vi: 'Tiếng Việt',
  }
  const SHORT_PHRASE_MAP: Record<string, string> = {
    // English
    hello: 'en',
    hi: 'en',
    hey: 'en',
    thanks: 'en',
    'thank you': 'en',
    yes: 'en',
    no: 'en',
    ok: 'en',
    okay: 'en',
    please: 'en',
    help: 'en',
    good: 'en',
    bye: 'en',
    goodbye: 'en',
    'good morning': 'en',
    'good evening': 'en',
    'good night': 'en',
    // Chinese
    你好: 'zh',
    您好: 'zh',
    嗨: 'zh',
    谢谢: 'zh',
    好的: 'zh',
    是的: 'zh',
    不是: 'zh',
    帮忙: 'zh',
    再见: 'zh',
    早上好: 'zh',
    晚上好: 'zh',
    请问: 'zh',
    好: 'zh',
    行: 'zh',
    可以: 'zh',
    // Japanese
    こんにちは: 'ja',
    おはよう: 'ja',
    ありがとう: 'ja',
    はい: 'ja',
    いいえ: 'ja',
    すみません: 'ja',
    さようなら: 'ja',
    // 한국어
    안녕하세요: 'ko',
    감사합니다: 'ko',
    네: 'ko',
    아니요: 'ko',
    // Français
    bonjour: 'fr',
    merci: 'fr',
    salut: 'fr',
    oui: 'fr',
    non: 'fr',
    'au revoir': 'fr',
    // Deutsch
    hallo: 'de',
    danke: 'de',
    ja: 'de',
    nein: 'de',
    tschüss: 'de',
    bitte: 'de',
    // Español
    hola: 'es',
    gracias: 'es',
    sí: 'es',
    adiós: 'es',
    'por favor': 'es',
    'buenos días': 'es',
    // Português
    olá: 'pt',
    obrigado: 'pt',
    obrigada: 'pt',
    sim: 'pt',
    não: 'pt',
    tchau: 'pt',
    // Русский
    привет: 'ru',
    спасибо: 'ru',
    да: 'ru',
    нет: 'ru',
    пожалуйста: 'ru',
    // العربية
    مرحبا: 'ar',
    شكرا: 'ar',
    نعم: 'ar',
    لا: 'ar',
    // ไทย
    สวัสดี: 'th',
    ขอบคุณ: 'th',
    // Tiếng Việt
    'xin chào': 'vi',
    'cảm ơn': 'vi',
  }
  // CJK languages use character set detection, reliable even for short text; Latin languages use statistics, require sufficient length
  const CJK_RELIABLE_CODES = new Set(['zh', 'ja', 'ko', 'th', 'ar', 'ru'])

  const detectUserLanguage = (message: string, history: EngineMessage[]): string => {
    // Short-circuit: any CJK Han character → treat as zh/ja/ko directly.
    // tinyld misclassifies short mixed-script messages (e.g. zh + a few Latin tokens)
    // as Latin, which then routes status text to the wrong language.
    if (/\p{Script=Han}/u.test(message)) {
      const cjkCode = detect(message)
      if (cjkCode === 'ja' || cjkCode === 'ko') return LANGUAGE_LABELS[cjkCode]
      return LANGUAGE_LABELS.zh
    }
    const normalized = message.trim().toLowerCase()
    const phraseCode = SHORT_PHRASE_MAP[normalized]
    if (phraseCode && LANGUAGE_LABELS[phraseCode]) return LANGUAGE_LABELS[phraseCode]
    const code = detect(message)
    // Trust CJK and other non-Latin short text; Latin languages need >= 8 chars
    if (code && LANGUAGE_LABELS[code] && (CJK_RELIABLE_CODES.has(code) || message.length >= 8))
      return LANGUAGE_LABELS[code]
    const recentUserMessages = history
      .filter((m) => m.role === 'user' && m.content && m.content.length >= 8)
      .slice(-3)
    for (let i = recentUserMessages.length - 1; i >= 0; i--) {
      const histCode = detect(recentUserMessages[i].content!)
      if (histCode && LANGUAGE_LABELS[histCode]) return LANGUAGE_LABELS[histCode]
    }
    if (code && LANGUAGE_LABELS[code]) return LANGUAGE_LABELS[code]
    // Fallback: use frontend preferred locale if provided, otherwise default to Chinese
    if (preferredLocale) {
      const localeCode = preferredLocale.startsWith('en') ? 'en' : preferredLocale.split('-')[0]
      if (LANGUAGE_LABELS[localeCode]) return LANGUAGE_LABELS[localeCode]
    }
    return LANGUAGE_LABELS.zh
  }

  const userLanguage = detectUserLanguage(userMessage, historyMessages)
  const isZh = userLanguage === '简体中文'
  const lang = isZh ? 'zh' : 'en'
  logger.info('Language detection', { userMessage: userMessage.slice(0, 50), userLanguage, lang })

  // Multilingual progress text
  const PROGRESS_MESSAGES = {
    queryingKnowledge: t('queryingKnowledge', lang),
    generating: t('generating', lang),
  }

  // Move time-consuming operations 5-13 inside stream, to push progress events
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      /** Safe enqueue — silently skip after controller closes, avoid crash */
      const safeEnqueue = (chunk: Uint8Array) => {
        try {
          controller.enqueue(chunk)
        } catch {
          // controller was cancelled by consumer (e.g. SSE timeout), silently ignore
        }
      }

      /** Push progress hint */
      const pushProgress = (message: string) => {
        const event: ConversationEvent = { type: 'progress', data: { message } }
        safeEnqueue(encodeSSE(event))
      }

      // Push "thinking" immediately, for frontend to display (following user input language)
      pushProgress(t('thinking', lang))

      const taskId = uuidv4()
      const taskStartTime = Date.now()
      await db.insert(taskExecutions).values({
        id: taskId,
        employeeId: conv.employeeId,
        triggerType: 'conversation',
        status: 'running',
        input: { conversationId, message: userMessage.slice(0, 500) },
        inputSummary: userMessage.slice(0, 200),
        startedAt: new Date(),
      })

      try {
        // File-only short-circuit: user only sent files without text, reply asking for requirements, skip intent and SOP
        if (hasFileOnly) {
          const fileNames = fileMetadata!.map((f) => `「${f.name}」`).join('、')
          const replyContent = t('convFileReceived', lang, { files: fileNames })
          const assistantMsgId = uuidv4()
          await db.insert(conversationMessages).values({
            id: assistantMsgId,
            conversationId,
            role: 'assistant',
            content: replyContent,
          })
          await db
            .update(conversations)
            .set({
              messageCount: sql`${conversations.messageCount} + 2`,
              lastMessageAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(conversations.id, conversationId))

          const startEvent: ConversationEvent = { type: 'message:start', data: { round: 0 } }
          safeEnqueue(encodeSSE(startEvent))
          const deltaEvent: ConversationEvent = {
            type: 'message:delta',
            data: { content: replyContent },
          }
          safeEnqueue(encodeSSE(deltaEvent))
          const doneEvent: ConversationEvent = {
            type: 'message:done',
            data: { messageId: assistantMsgId, tokensUsed: 0, references: [] },
          }
          safeEnqueue(encodeSSE(doneEvent))

          await db
            .update(taskExecutions)
            .set({
              status: 'success',
              outputSummary: replyContent.slice(0, 200),
              tokensUsed: 0,
              durationMs: Date.now() - taskStartTime,
              completedAt: new Date(),
            })
            .where(eq(taskExecutions.id, taskId))

          logger.info('File-only short circuit: replied asking for requirements', {
            conversationId,
            fileNames,
          })
          return
        }

        // Resolve caller identity for SOP-visibility filtering (cached 5min for IM;
        // the SOP bridge reuses the same cache). IM channels resolve from their
        // directory; web resolves from the platform user + RBAC roles (gated under
        // the synthetic 'web' connection). 'api' (and any other non-IM) yield a
        // null identity and null connectionId → default visibility.
        let visibilityIdentity: ScopeIdentity | null
        let visibilityConnectionId: string | null
        if (conv.channel === 'web') {
          visibilityIdentity = await resolveWebIdentity(userId)
          visibilityConnectionId = 'web'
        } else if (conv.channel && conv.channel !== 'api') {
          visibilityIdentity = await resolveChannelIdentity({
            channel: conv.channel,
            userId,
            config: channelConfig,
          })
          visibilityConnectionId = connectionId ?? null
        } else {
          visibilityIdentity = null
          visibilityConnectionId = null
        }

        // 5-7. Load tool config, model config, knowledge base IDs in parallel (three independent queries)
        const [
          { tools, workflowMap, sopMap, skillMap, sopInfos, deniedSopInfos, deniedSopMap },
          modelConfig,
          kbIds,
        ] = await Promise.all([
          buildWorkflowToolConfigs(conv.employeeId, {
            identity: visibilityIdentity,
            connectionId: visibilityConnectionId,
          }),
          resolveModelConfig(conv.employeeId, conv.workspaceId),
          getEmployeeKnowledgeBaseIds(conv.employeeId),
        ])
        const hasKnowledgeBase = kbIds.length > 0
        const hasTools = tools.length > 0
        const sopNames = sopInfos.map((s) => s.name)

        const intentResult = await classifyIntent(userMessage, historyMessages, modelConfig, {
          hasKnowledgeBase,
          hasTools,
          sopNames,
          workflowNames: [],
        })

        logger.info('Intent classification result', {
          intent: intentResult.intent,
          reason: intentResult.reason,
        })

        // Push intent classification result to frontend
        const intentEvent: ConversationEvent = {
          type: 'intent:classified',
          data: {
            intent: intentResult.intent,
            reason: intentResult.reason,
            hasKnowledgeReference: false,
          },
        }
        safeEnqueue(encodeSSE(intentEvent))

        // 8. Query knowledge base based on intent
        let knowledgeReference: string | null = null
        let knowledgeReferences: KnowledgeChunkReference[] = []

        if (
          (intentResult.intent === 'knowledge_only' ||
            intentResult.intent === 'knowledge_then_sop') &&
          hasKnowledgeBase
        ) {
          pushProgress(PROGRESS_MESSAGES.queryingKnowledge)
          // Always retrieve against the user's original wording. The intent
          // classifier strips signal words ("...的参数", "...怎么用") down to
          // keyword stubs, which then over-recalls product-overview chunks
          // instead of the parameter/spec chunk the user actually asked for.
          const searchQuery = userMessage
          const kbResult = await queryEmployeeKnowledge(conv.employeeId, searchQuery)

          if (kbResult.success && kbResult.referenceText) {
            knowledgeReference = kbResult.referenceText
            knowledgeReferences = kbResult.references
            logger.info('Knowledge base search completed, reference info injected', {
              resultCount: kbResult.resultCount,
            })
          }

          const kbEvent: ConversationEvent = {
            type: 'knowledge:result',
            data: { resultCount: knowledgeReferences.length },
          }
          safeEnqueue(encodeSSE(kbEvent))
        }

        // 9. Determine tool set based on intent
        const effectiveTools = intentResult.intent === 'knowledge_only' ? [] : tools

        // 10. Build SOP name map (tool function name -> display name)
        const sopNameMap = new Map<string, string>()
        for (const info of sopInfos) {
          sopNameMap.set(`sop_${info.id}`, info.name)
        }

        // 11. Build system prompt (language already detected outside stream)
        const systemPrompt = buildSystemPrompt(
          employee,
          [],
          sopInfos,
          knowledgeReference,
          userLanguage,
          deniedSopInfos
        )

        logger.info('Tool list', {
          toolCount: effectiveTools.length,
          tools: effectiveTools.map((t) => ({
            name: t.function.name,
            description: t.function.description,
          })),
          intent: intentResult.intent,
        })
        logger.info('System prompt', { systemPrompt: systemPrompt.slice(0, 1000) })

        // 11. Build context window
        const contextMessages = buildContextWindow(historyMessages, systemPrompt)

        // 12. Enter message loop
        pushProgress(PROGRESS_MESSAGES.generating)

        const loopResult = await runMessageLoop(
          safeEnqueue,
          conversationId,
          conv.employeeId,
          userId,
          conv.workspaceId,
          systemPrompt,
          contextMessages,
          effectiveTools,
          workflowMap,
          sopMap,
          sopNameMap,
          deniedSopMap,
          skillMap,
          modelConfig,
          userMessage,
          knowledgeReferences,
          taskId,
          isZh,
          channelConfig
        )
        await db
          .update(taskExecutions)
          .set({
            status: 'success',
            outputSummary: loopResult.outputSummary,
            tokensUsed: loopResult.totalTokens,
            durationMs: Date.now() - taskStartTime,
            completedAt: new Date(),
          })
          .where(eq(taskExecutions.id, taskId))
        await db.insert(workLogs).values({
          id: uuidv4(),
          taskId,
          employeeId: conv.employeeId,
          logType: 'action',
          content: t('conversationDone', 'en'),
          metadata: makeLogMetadata(
            { conversationId, tokensUsed: loopResult.totalTokens },
            { i18nKey: 'conversationDone', i18nParams: {} }
          ),
        })
      } catch (error) {
        const msg = error instanceof Error ? error.message : t('unknownError', lang)
        logger.error('Conversation engine error', error)
        const event: ConversationEvent = { type: 'error', data: { message: msg } }
        safeEnqueue(encodeSSE(event))
        await db
          .update(taskExecutions)
          .set({
            status: 'failed',
            errorMessage: msg,
            durationMs: Date.now() - taskStartTime,
            completedAt: new Date(),
          })
          .where(eq(taskExecutions.id, taskId))
          .catch(() => {})
        await db
          .insert(workLogs)
          .values({
            id: uuidv4(),
            taskId,
            employeeId: conv.employeeId,
            logType: 'error',
            content: `${t('convProcessFailed', 'en')}: ${msg}`,
            metadata: makeLogMetadata(
              { conversationId },
              { i18nKey: 'convProcessFailed', i18nParams: { msg } }
            ),
          })
          .catch(() => {})
      } finally {
        try {
          controller.close()
        } catch {
          /* already closed */
        }
      }
    },
  })
}

interface ModelConfig {
  providerId: string
  model: string
  apiKey: string
  baseUrl: string
}

/**
 * Message loop — supports multi-round tool_call
 */
async function runMessageLoop(
  enqueue: (chunk: Uint8Array) => void,
  conversationId: string,
  employeeId: string,
  userId: string,
  workspaceId: string,
  systemPrompt: string,
  contextMessages: EngineMessage[],
  tools: OpenAITool[],
  workflowMap: Map<string, string>,
  sopMap: Map<string, string>,
  sopNameMap: Map<string, string>,
  /** sopToolName (`sop_<id>`) → denied SOP descriptor; calls to these are rejected program-side. */
  deniedSopMap: Map<string, { id: string; name: string }>,
  skillMap: Map<string, { skillId: string; endpoint: string; openclawConnectionId?: string }>,
  modelConfig: ModelConfig,
  userMessage: string,
  knowledgeReferences: KnowledgeChunkReference[] = [],
  taskId = '',
  isZh = true,
  /** Credentials of the connection that received the message — threaded to SOP identity resolution. */
  channelConfig?: Record<string, unknown>
): Promise<{ outputSummary: string | null; totalTokens: number }> {
  const lang = isZh ? 'zh' : 'en'
  const messages: EngineMessage[] = [{ role: 'system', content: systemPrompt }, ...contextMessages]

  let totalTokens = 0

  /** Files produced during tool execution (uploaded to MinIO), written to assistant message metadata */
  const collectedFileMetadata: FileAttachment[] = []

  /** Set of SOP IDs triggered in this conversation round — prevent cross-round duplicate triggers */
  const triggeredSopIds = new Set<string>()

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    // Notify frontend message started
    const startEvent: ConversationEvent = {
      type: 'message:start',
      data: { round },
    }
    enqueue(encodeSSE(startEvent))

    const { content, toolCalls, usage } = await callLLM(enqueue, messages, tools, modelConfig)
    totalTokens += usage.total

    // Write model call log
    logModelUsage({
      provider: modelConfig.providerId,
      model: modelConfig.model,
      userId,
      employeeId,
      response: {
        content: content ?? '',
        model: modelConfig.model,
        tokens: { input: usage.input, output: usage.output, total: usage.total },
      },
    })
    if (taskId) {
      db.insert(workLogs)
        .values({
          id: uuidv4(),
          taskId,
          employeeId,
          logType: 'llm_call',
          content: t('convModelUsage', 'en', {
            model: modelConfig.model,
            tokens: String(usage.total),
          }),
          metadata: makeLogMetadata(
            {
              model: modelConfig.model,
              tokensInput: usage.input,
              tokensOutput: usage.output,
              round,
            },
            {
              i18nKey: 'convModelUsage',
              i18nParams: { model: modelConfig.model, tokens: usage.total },
            }
          ),
        })
        .catch(() => {})
    }

    // Plain text reply — save and end
    if (!toolCalls || toolCalls.length === 0) {
      const assistantMsgId = uuidv4()

      await db.insert(conversationMessages).values({
        id: assistantMsgId,
        conversationId,
        role: 'assistant',
        content: content ?? '',
        tokensUsed: usage.total,
        metadata: {
          ...(knowledgeReferences.length > 0 ? { references: knowledgeReferences } : {}),
          ...(collectedFileMetadata.length > 0 ? { files: collectedFileMetadata } : {}),
        },
      })

      // Update conversation statistics
      await db
        .update(conversations)
        .set({
          messageCount: sql`${conversations.messageCount} + 2`,
          totalTokens: sql`${conversations.totalTokens} + ${totalTokens}`,
          lastMessageAt: new Date(),
          updatedAt: new Date(),
          title: sql`CASE WHEN ${conversations.title} IS NULL THEN ${(content ?? '').slice(0, 50)} ELSE ${conversations.title} END`,
        })
        .where(eq(conversations.id, conversationId))

      const doneEvent: ConversationEvent = {
        type: 'message:done',
        data: {
          messageId: assistantMsgId,
          tokensUsed: totalTokens,
          references: knowledgeReferences,
        },
      }
      enqueue(encodeSSE(doneEvent))
      return { outputSummary: (content ?? '').slice(0, 200) || null, totalTokens }
    }

    // Has tool_calls — save assistant message
    // Discard content of tool_call rounds, prevent LLM from seeing already-answered content in later rounds and generating duplicates
    const assistantToolMsgId = uuidv4()
    await db.insert(conversationMessages).values({
      id: assistantToolMsgId,
      conversationId,
      role: 'assistant',
      content: null,
      toolCalls,
      tokensUsed: usage.total,
    })

    messages.push({ role: 'assistant', content: null, tool_calls: toolCalls })

    // Process each tool_call (max 1 SOP per round)
    let sopCalledThisRound = false
    let hasRealToolExecution = false
    for (const tc of toolCalls) {
      const toolDisplayName = tc.function.name.startsWith('sop_')
        ? t('sopLabel', lang)
        : tc.function.name
      const toolStartEvent: ConversationEvent = {
        type: 'tool:start',
        data: {
          toolCallId: tc.id,
          toolName: tc.function.name,
          displayMessage: t('executingTool', lang, { name: toolDisplayName }),
        },
      }
      enqueue(encodeSSE(toolStartEvent))

      let toolResult: string
      let skipPersist = false // Intercepted responses not saved to conversation history, avoid refreshing expiry window
      const wfId = workflowMap.get(tc.function.name)
      const sopId = sopMap.get(tc.function.name)
      const skillInfo = skillMap.get(tc.function.name)
      const deniedSop = deniedSopMap.get(tc.function.name)

      let args: Record<string, unknown> = {}
      try {
        args = JSON.parse(tc.function.arguments)
      } catch {
        args = { raw: tc.function.arguments }
      }

      if (tc.function.name === 'check_sop_status') {
        // SOP status query
        const executionId = (args.execution_id as string) ?? ''
        if (!executionId) {
          toolResult = t('missingExecutionId', lang)
        } else {
          const statusResult = await querySopExecutionStatus(executionId, lang)
          toolResult = statusResult.summary
        }
      } else if (tc.function.name === 'query_my_tasks') {
        // User task list query
        const filter = (args.filter as TaskFilter) ?? 'all'
        const limit = typeof args.limit === 'number' ? args.limit : 10
        const taskResult = await queryUserTasks(userId, filter, limit)
        toolResult = taskResult.summary
      } else if (deniedSop) {
        // Restricted task: caller lacks permission. Reject program-side without
        // executing; the message is returned so the LLM relays the refusal.
        // hasRealToolExecution stays false; no SOP dedup/trigger logic runs.
        toolResult = t('sopNoPermission', lang, { name: deniedSop.name })
        logger.warn('Denied SOP invocation blocked program-side', {
          conversationId,
          tool: tc.function.name,
          sopId: deniedSop.id,
        })
      } else if (wfId) {
        // Workflow call
        hasRealToolExecution = true
        const result = await executeWorkflowFromConversation(
          conversationId,
          employeeId,
          wfId,
          (args.input as Record<string, unknown>) ?? args,
          userId,
          workspaceId
        )

        toolResult = result.success
          ? (result.outputSummary ?? t('executionSuccess', lang))
          : `${t('convExecFailed', lang)}: ${result.errorMessage}`
      } else if (sopId) {
        // Rate limit: max 1 SOP per tool_calls round; no duplicate trigger for same SOP across rounds; no duplicate trigger within 5 min across requests
        let recentlyTriggered = false
        if (!triggeredSopIds.has(sopId)) {
          // Check DB: same user + same SOP + same user message + triggered within last 5 min
          // Use database time NOW() for comparison, avoid JS/DB timezone inconsistency causing misjudgment
          const [recent] = await db
            .select({ id: sopExecutions.id })
            .from(sopExecutions)
            .where(
              and(
                eq(sopExecutions.sopDefinitionId, sopId),
                eq(sopExecutions.triggeredBy, userId),
                sql`${sopExecutions.createdAt} > NOW() - INTERVAL '5 minutes'`,
                sql`${sopExecutions.triggerData}->>'input' = ${userMessage}`
              )
            )
            .limit(1)
          recentlyTriggered = !!recent
          if (recentlyTriggered) {
            logger.warn(
              `SOP duplicate trigger within 5 minutes intercepted: sopId=${sopId}, conversation=${conversationId}, message=${userMessage.slice(0, 50)}`
            )
          }
        }

        if (sopCalledThisRound) {
          toolResult = t('taskSkipped', lang)
          skipPersist = true
          logger.warn(
            `SOP concurrent call intercepted: sopId=${sopId}, conversation=${conversationId}`
          )
        } else if (triggeredSopIds.has(sopId)) {
          toolResult = t('taskAlreadyTriggered', lang)
          skipPersist = true
          logger.warn(
            `SOP duplicate trigger intercepted: sopId=${sopId}, conversation=${conversationId}`
          )
        } else if (recentlyTriggered) {
          toolResult = t('taskRecentlyExecuted', lang)
          skipPersist = true
        } else {
          triggeredSopIds.add(sopId)
          sopCalledThisRound = true

          // Push progress: inform user which SOP is being executed
          const sopDisplayName = sopNameMap.get(tc.function.name) ?? 'SOP'
          const sopProgressEvent: ConversationEvent = {
            type: 'progress',
            data: { message: t('executingTask', lang, { name: sopDisplayName }) },
          }
          enqueue(encodeSSE(sopProgressEvent))

          // SOP call (with timeout wait)
          // Inject original user message into input, ensure SOP start_trigger can access it.
          // LLM-extracted precise params (sopInput) expanded later; same-name fields override input.
          const sopInput = (args.input as Record<string, unknown>) ?? args
          // Grab the most recent user message with [附件: url=...] from history, take all [附件] annotations
          // append to input end, ensure SOP inner LLM can see real file URLs (prevent hallucinated public URLs)
          let sopInputMessage = userMessage
          for (let i = messages.length - 1; i >= 0; i--) {
            const m = messages[i]
            if (m.role !== 'user' || typeof m.content !== 'string') continue
            const matches = m.content.match(/\[附件:[^\]]+\]/g)
            if (matches && matches.length > 0) {
              sopInputMessage = `${userMessage}\n\n${matches.join('\n')}`
              break
            }
          }
          const triggerData: Record<string, unknown> = {
            input: sopInputMessage,
            ...sopInput,
          }
          const result = await executeSopFromConversation(
            conversationId,
            employeeId,
            sopId,
            triggerData,
            userId,
            (progressMsg) => {
              const progressEvent: ConversationEvent = {
                type: 'progress',
                data: { message: progressMsg },
              }
              enqueue(encodeSSE(progressEvent))
            },
            isZh,
            channelConfig
          )

          if (!result.success) {
            toolResult = `${t('taskStartFailed', lang)}: ${result.errorMessage}`
          } else if (result.completed && result.output) {
            // SOP execution completed, return actual result
            let outputForLLM = result.output
            // If output contains files base64, clean up to prevent LLM from outputting raw encoding
            try {
              const parsed = JSON.parse(result.output)
              if (typeof parsed === 'object' && parsed !== null && Array.isArray(parsed.files)) {
                const { files: _files, ...rest } = parsed
                outputForLLM =
                  Object.keys(rest).length > 0
                    ? JSON.stringify(rest, null, 2)
                    : (parsed.result ?? t('executionDone', lang))
              }
            } catch {
              /* not JSON, use directly */
            }

            // Build human-facing "file generated" note from both sources:
            //   - result.files          : base64 from non-mount tools
            //   - result.workspaceFiles : already in conversations/, from mounted tools
            const fileNames = [
              ...(result.files?.map((f) => f.name) ?? []),
              ...(result.workspaceFiles?.map((f) => f.name) ?? []),
            ]
            const fileNoteText =
              fileNames.length > 0
                ? `\n\n[${t('fileGenerated', lang)}: ${fileNames.join(', ')}. ${t('fileNote', lang)}]`
                : ''
            toolResult = `${t('taskCompleted', lang, { name: result.sopName, id: result.executionId })}\n\n${outputForLLM}${fileNoteText}`

            // Surface attachments via SSE message:files event:
            //   - base64 files need uploadFilesToMinio (writes to conversations/)
            //   - workspaceFiles are already in conversations/ (sop-bridge
            //     copied them via CopyObject) — use directly
            const baseFiles =
              result.files && result.files.length > 0
                ? await uploadFilesToMinio(conversationId, result.files, collectedFileMetadata)
                : []
            // Match the shape uploadFilesToMinio returns so the SSE event
            // is consistent. Workspace files have no base64 payload.
            const workspaceFilesForSse = (result.workspaceFiles ?? []).map((f) => ({
              name: f.name,
              mimeType: f.mimeType,
              base64: '',
              key: f.key,
            }))
            if (result.workspaceFiles && result.workspaceFiles.length > 0) {
              collectedFileMetadata.push(...result.workspaceFiles)
            }
            const allFiles = [...baseFiles, ...workspaceFilesForSse]
            if (allFiles.length > 0) {
              const filesEvent: ConversationEvent = {
                type: 'message:files',
                data: { files: allFiles },
              }
              enqueue(encodeSSE(filesEvent))
            }
          } else if (result.completed && !result.output) {
            toolResult = t('taskCompletedNoOutput', lang, {
              name: result.sopName,
              id: result.executionId,
            })
          } else {
            // SOP still executing asynchronously (e.g. awaiting human confirmation)
            toolResult = t('taskStarted', lang, { name: result.sopName, id: result.executionId })
          }
        }
      } else if (skillInfo) {
        if (skillInfo.openclawConnectionId) {
          /**
           * OpenClaw async dispatch — fire-and-forget.
           * Return immediate ack to the LLM; real result is persisted to
           * `conversation_messages` + pushed via IM channel by the handler.
           */
          hasRealToolExecution = true
          const openclawTaskId = uuidv4()

          const { dispatchOpenclawAsync } = await import('@/lib/openclaw/async-handler')
          void dispatchOpenclawAsync({
            taskId: openclawTaskId,
            conversationId,
            connectionId: skillInfo.openclawConnectionId,
            args: {
              message: typeof args.message === 'string' ? args.message : '',
              ...(typeof args.model === 'string' && args.model !== ''
                ? { model: args.model }
                : {}),
            },
          })

          toolResult = JSON.stringify({
            status: 'pending',
            task_id: openclawTaskId,
            message: 'OpenClaw 已收到任务，正在处理中。结果将稍后追加到对话。',
          })
        } else {
          // Skill tool call — HTTP POST to deployed K8S endpoint
          try {
            const skillResponse = await fetch(skillInfo.endpoint, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(args.input ?? args),
            })
            const skillResult = (await skillResponse.json()) as {
              success: boolean
              result?: unknown
              error?: string
              files?: Array<{ name: string; mimeType: string; base64: string }>
            }
            if (skillResult.success) {
              toolResult =
                typeof skillResult.result === 'string'
                  ? skillResult.result
                  : JSON.stringify(skillResult.result ?? null, null, 2)

              // Tool returned attachments -> upload to MinIO + push message:files event
              if (skillResult.files && skillResult.files.length > 0) {
                const filesWithKeys = await uploadFilesToMinio(
                  conversationId,
                  skillResult.files,
                  collectedFileMetadata
                )
                const filesEvent: ConversationEvent = {
                  type: 'message:files',
                  data: { files: filesWithKeys },
                }
                enqueue(encodeSSE(filesEvent))
              }
              if (taskId) {
                db.insert(workLogs)
                  .values({
                    id: uuidv4(),
                    taskId,
                    employeeId,
                    logType: 'tool_call',
                    content: `Tool "${tc.function.name}" ${t('toolCallSuccess', 'en')}`,
                    metadata: makeLogMetadata(
                      { toolName: tc.function.name, skillId: skillInfo.skillId },
                      { i18nKey: 'toolCallSuccess', i18nParams: { name: tc.function.name } }
                    ),
                  })
                  .catch(() => {})
              }
            } else {
              toolResult = `${t('toolCallFailed', lang)}: ${skillResult.error ?? t('unknownError', lang)}`
              if (taskId) {
                const failError = skillResult.error ?? t('unknownError', 'en')
                db.insert(workLogs)
                  .values({
                    id: uuidv4(),
                    taskId,
                    employeeId,
                    logType: 'error',
                    content: `Tool "${tc.function.name}" ${t('toolCallFailedShort', 'en')}: ${failError}`,
                    metadata: makeLogMetadata(
                      { toolName: tc.function.name, skillId: skillInfo.skillId },
                      {
                        i18nKey: 'toolCallFailedShort',
                        i18nParams: { name: tc.function.name, error: failError },
                      }
                    ),
                  })
                  .catch(() => {})
              }
            }
          } catch (e) {
            const errMsg = e instanceof Error ? e.message : String(e)
            logger.error(`Skill tool call failed: ${skillInfo.skillId}`, { error: errMsg })
            toolResult = `${t('convToolCallFailed', lang)}: ${errMsg}`
            if (taskId) {
              db.insert(workLogs)
                .values({
                  id: uuidv4(),
                  taskId,
                  employeeId,
                  logType: 'error',
                  content: t('toolCallError', 'en', { name: tc.function.name, error: errMsg }),
                  metadata: makeLogMetadata(
                    { toolName: tc.function.name, skillId: skillInfo.skillId },
                    {
                      i18nKey: 'toolCallError',
                      i18nParams: { name: tc.function.name, error: errMsg },
                    }
                  ),
                })
                .catch(() => {})
            }
          }
        }
      } else {
        toolResult = `${t('convUnknownTool', lang)}: ${tc.function.name}`
      }

      // Save tool result message (intercepted responses not saved, avoid refreshing expiry window)
      if (!skipPersist) {
        const toolMsgId = uuidv4()
        await db.insert(conversationMessages).values({
          id: toolMsgId,
          conversationId,
          role: 'tool',
          content: toolResult,
          toolCallId: tc.id,
          toolName: tc.function.name,
        })
      }

      messages.push({
        role: 'tool',
        content: toolResult,
        tool_call_id: tc.id,
        name: tc.function.name,
      })

      const toolResultEvent: ConversationEvent = {
        type: 'tool:result',
        data: {
          toolCallId: tc.id,
          toolName: tc.function.name,
          result: toolResult.slice(0, 500),
          displayMessage: t('executedTool', lang, { name: toolDisplayName }),
        },
      }
      enqueue(encodeSSE(toolResultEvent))
    }

    // Continue loop to let LLM process tool results
  }

  // Max rounds reached
  logger.warn(`Conversation ${conversationId} reached max tool call rounds ${MAX_TOOL_ROUNDS}`)
  const errorEvent: ConversationEvent = {
    type: 'error',
    data: { message: t('toolRoundExceeded', lang) },
  }
  enqueue(encodeSSE(errorEvent))
  return { outputSummary: null, totalTokens }
}

interface LLMUsage {
  total: number
  input: number
  output: number
}

interface LLMResult {
  content: string | null
  toolCalls: ToolCall[] | null
  usage: LLMUsage
}

/**
 * Call OpenAI-compatible LLM API (streaming)
 */
async function callLLM(
  enqueue: (chunk: Uint8Array) => void,
  messages: EngineMessage[],
  tools: OpenAITool[],
  config: ModelConfig
): Promise<LLMResult> {
  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  }

  if (tools.length > 0) {
    body.tools = tools
    body.tool_choice = 'auto'
  }

  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`LLM API ${t('convError')} (${response.status}): ${errorText.slice(0, 300)}`)
  }

  if (!response.body) {
    throw new Error(t('emptyLLMResponse'))
  }

  return parseSSEStream(enqueue, response.body)
}

/**
 * Parse OpenAI-compatible SSE stream
 */
async function parseSSEStream(
  enqueue: (chunk: Uint8Array) => void,
  body: ReadableStream<Uint8Array>
): Promise<LLMResult> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let contentAccum = ''
  let usage: LLMUsage = { total: 0, input: 0, output: 0 }
  const toolCallsAccum: Map<number, { id: string; name: string; arguments: string }> = new Map()

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || !trimmed.startsWith('data: ')) continue
        const data = trimmed.slice(6)
        if (data === '[DONE]') continue

        let chunk: ChatCompletionChunk
        try {
          chunk = JSON.parse(data) as ChatCompletionChunk
        } catch {
          continue
        }

        if (chunk.usage) {
          usage = {
            total: chunk.usage.total_tokens ?? 0,
            input: chunk.usage.prompt_tokens ?? 0,
            output: chunk.usage.completion_tokens ?? 0,
          }
        }

        const delta = chunk.choices?.[0]?.delta
        if (!delta) continue

        // Text content stream (buffer first, decide whether to push after stream ends)
        if (delta.content) {
          contentAccum += delta.content
        }

        // tool_calls streaming accumulation
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const existing = toolCallsAccum.get(tc.index)
            if (existing) {
              if (tc.function?.arguments) {
                existing.arguments += tc.function.arguments
              }
            } else {
              toolCallsAccum.set(tc.index, {
                id: tc.id ?? '',
                name: tc.function?.name ?? '',
                arguments: tc.function?.arguments ?? '',
              })
            }
          }
        }
      }
    }
  } finally {
    reader.releaseLock()
  }

  // Build tool_calls result
  let toolCalls: ToolCall[] | null = null
  if (toolCallsAccum.size > 0) {
    toolCalls = Array.from(toolCallsAccum.values()).map((tc) => ({
      id: tc.id,
      type: 'function' as const,
      function: {
        name: tc.name,
        arguments: tc.arguments,
      },
    }))
  }

  // Only push delta to frontend for plain text replies (no tool_calls)
  // With tool_calls, content is only for message history, not pushed, avoid generating duplicate content in later rounds
  if (!toolCalls && contentAccum) {
    const deltaEvent: ConversationEvent = {
      type: 'message:delta',
      data: { content: contentAccum },
    }
    enqueue(encodeSSE(deltaEvent))
  }

  return {
    content: contentAccum || null,
    toolCalls,
    usage,
  }
}

/**
 * Upload tool-returned base64 files to MinIO, collect metadata
 *
 * @returns File list with key field (for SSE events to carry, frontend can build download links)
 */
async function uploadFilesToMinio(
  conversationId: string,
  files: Array<{ name: string; mimeType: string; base64: string }>,
  collectedFileMetadata: FileAttachment[]
): Promise<Array<{ name: string; mimeType: string; base64: string; key: string }>> {
  const filesWithKeys: Array<{ name: string; mimeType: string; base64: string; key: string }> = []

  for (const f of files) {
    try {
      const buf = Buffer.from(f.base64, 'base64')
      const attachment = await uploadConversationFile(conversationId, f.name, buf, f.mimeType)
      collectedFileMetadata.push(attachment)
      filesWithKeys.push({ ...f, key: attachment.key })
    } catch (err) {
      logger.warn('Tool returned file upload to MinIO failed', { fileName: f.name, error: err })
      // Keep base64 on upload failure, channel side can still send
      filesWithKeys.push({ ...f, key: '' })
    }
  }

  return filesWithKeys
}
