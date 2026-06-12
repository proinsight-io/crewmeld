/**
 * LLM + multi-tool executor — non-streaming, for SOP digital employee nodes
 *
 * Same logic as conversation engine runMessageLoop, but:
 * - Non-streaming calls (SOP is server-side execution, no real-time push needed)
 * - Does not save messages to conversationMessages table
 * - Outputs structured results for SOP engine use
 */

import { randomUUID } from 'node:crypto'
import { createLogger } from '@crewmeld/logger'
import type { ConversationModelConfig } from '@/lib/conversation/types'
import { t } from '@/lib/core/server-i18n'
import type { ScopeIdentity } from '@/lib/identity/types'
import type { ApiToolSpec } from '@/lib/tools/api-tool-types'
import type { ToolEndpointInfo } from './tool-builder'

const logger = createLogger('SopLLMToolExecutor')

const TOOL_CALL_TIMEOUT_MS = 60_000

interface OpenAIToolDef {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

interface ToolResult {
  toolName: string
  toolId: string
  input: Record<string, unknown>
  output: unknown
  round: number
}

export interface LLMToolExecutionResult {
  summary: string | null
  toolResults: ToolResult[]
  rounds: number
  totalTokens: number
  /** Unrecoverable error detected by LLM self-judgment or fallback logic */
  error?: string
}

export interface ToolCallLogEntry {
  toolName: string
  toolId: string
  instanceName: string
  input: Record<string, unknown>
  output: unknown
  success: boolean
  round: number
  durationMs: number
}

interface ExecuteLLMWithToolsParams {
  modelConfig: ConversationModelConfig
  tools: OpenAIToolDef[]
  toolEndpoints: Map<string, ToolEndpointInfo>
  systemPrompt: string
  userMessage: string
  maxRounds?: number
  /** Callback after each tool call completion, for writing work logs */
  onToolResult?: (entry: ToolCallLogEntry) => Promise<void>
  /**
   * The SOP execution id this LLM call belongs to. When set, mounted
   * tool calls (needsFileMount=true) get this id injected into the
   * request body as `_sopExecutionId` so the shared Pod can scope its
   * filesystem access (/workspace/{execId}/, flat layout — inputs and
   * outputs share the same directory, persisted on the SOP workspace PVC).
   */
  sopExecutionId?: string
  /**
   * Public base URL used to construct download links the tool returns
   * (`_sopFileUrlPrefix`). Typically derived from APP_BASE_URL.
   */
  sopFileUrlPrefix?: string
  /**
   * In-process API tools (kind='api'), keyed by tool name.
   * Each entry carries the spec AND the tool-level forwardIdentity flag so
   * the executor can pass it through to {@link runApiTool} without an extra
   * DB query.
   */
  apiTools?: Map<string, { spec: ApiToolSpec; forwardIdentity?: boolean }>
  /** Platform-resolved caller identity, forwarded to tools with forwardIdentity=true. Never from LLM. */
  identity?: ScopeIdentity
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
  name?: string
}

interface ChatCompletionResponse {
  choices: Array<{
    message: {
      role: string
      content: string | null
      tool_calls?: Array<{
        id: string
        type: 'function'
        function: { name: string; arguments: string }
      }>
    }
    finish_reason: string | null
  }>
  usage?: {
    total_tokens: number
  }
}

/**
 * Classify how an LLM tool call should be dispatched.
 *
 * Priority: builtin > apitool > http-endpoint > unknown.
 *
 * @param toolName - The name of the tool as reported by the LLM.
 * @param deps - Available tool registries to search.
 * @returns A discriminated union describing the dispatch kind.
 */
export function resolveToolCall(
  toolName: string,
  deps: {
    toolEndpoints?: Map<string, ToolEndpointInfo>
    builtinTools?: Map<string, (args: Record<string, unknown>) => Promise<unknown>>
    apiTools?: Map<string, { spec: ApiToolSpec; forwardIdentity?: boolean }>
  },
):
  | { kind: 'builtin'; handler: (args: Record<string, unknown>) => Promise<unknown> }
  | { kind: 'apitool'; spec: ApiToolSpec; forwardIdentity?: boolean }
  | { kind: 'http'; info: ToolEndpointInfo }
  | { kind: 'unknown' } {
  const builtin = deps.builtinTools?.get(toolName)
  if (builtin) return { kind: 'builtin', handler: builtin }
  const apiEntry = deps.apiTools?.get(toolName)
  if (apiEntry) return { kind: 'apitool', spec: apiEntry.spec, forwardIdentity: apiEntry.forwardIdentity }
  const info = deps.toolEndpoints?.get(toolName)
  if (info) return { kind: 'http', info }
  return { kind: 'unknown' }
}

/**
 * Non-streaming LLM multi-round tool call loop
 */
export async function executeLLMWithTools({
  modelConfig,
  tools,
  toolEndpoints,
  systemPrompt,
  userMessage,
  maxRounds = 5,
  onToolResult,
  sopExecutionId,
  sopFileUrlPrefix,
  apiTools,
  identity,
}: ExecuteLLMWithToolsParams): Promise<LLMToolExecutionResult> {
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage },
  ]

  const toolResults: ToolResult[] = []
  let totalTokens = 0

  logger.info('[LLM Agent] Starting execution - model/tools/prompt overview', {
    model: modelConfig.model,
    baseUrl: modelConfig.baseUrl,
    maxRounds,
    toolCount: tools.length,
    toolNames: tools.map((t) => t.function.name),
    toolDefinitions: tools.map((t) => ({
      name: t.function.name,
      desc: t.function.description,
      params: Object.keys((t.function.parameters as Record<string, unknown>)?.properties ?? {}),
    })),
    systemPromptLength: systemPrompt.length,
    userMessageLength: userMessage.length,
  })

  for (let round = 0; round < maxRounds; round++) {
    const response = await callLLMNonStreaming(messages, tools, modelConfig)
    totalTokens += response.usage?.total_tokens ?? 0

    const choice = response.choices[0]
    if (!choice) {
      logger.error('LLM returned empty choices')
      return { summary: null, toolResults, rounds: round + 1, totalTokens }
    }

    const msg = choice.message

    logger.info(`[LLM Agent] Round ${round + 1} model response - thinking/tool decisions`, {
      hasToolCalls: !!(msg.tool_calls && msg.tool_calls.length > 0),
      toolCallCount: msg.tool_calls?.length ?? 0,
      toolCallNames: msg.tool_calls?.map((tc) => tc.function.name) ?? [],
      toolCallArgs:
        msg.tool_calls?.map((tc) => ({
          name: tc.function.name,
          arguments: tc.function.arguments.slice(0, 300),
        })) ?? [],
      modelThinking: msg.content?.slice(0, 500) ?? null,
      finishReason: choice.finish_reason,
      tokensThisRound: response.usage?.total_tokens ?? 0,
    })

    // Plain text reply — end loop
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      logger.info(`[LLM Agent] Round ${round + 1} ended - model output final answer`, {
        summaryFull: msg.content ?? null,
        summaryLength: msg.content?.length ?? 0,
        totalToolResults: toolResults.length,
        totalTokens,
        toolsCalledSummary: toolResults.map((tr) => ({
          name: tr.toolName,
          round: tr.round,
          hasError: !!(
            tr.output &&
            typeof tr.output === 'object' &&
            'error' in (tr.output as Record<string, unknown>)
          ),
        })),
      })

      const result: LLMToolExecutionResult = {
        summary: msg.content,
        toolResults,
        rounds: round + 1,
        totalTokens,
      }

      // Detect LLM self-marked error
      const llmError = detectLLMErrorMarker(msg.content)
      if (llmError) {
        result.error = llmError
        logger.warn('LLM self-marked error, SOP node will terminate', { error: llmError })
        return result
      }

      // Fallback: force-mark error when all tool calls failed
      const fallbackError = detectAllToolsFailed(toolResults)
      if (fallbackError) {
        result.error = fallbackError
        logger.warn('Fallback detection: all tool calls failed, SOP node will terminate', {
          error: fallbackError,
        })
      }

      return result
    }

    // Has tool_calls — append assistant message
    messages.push({
      role: 'assistant',
      content: msg.content,
      tool_calls: msg.tool_calls,
    })

    // Execute each tool_call
    for (const tc of msg.tool_calls) {
      const endpointInfo = toolEndpoints.get(tc.function.name)

      let args: Record<string, unknown> = {}
      try {
        args = JSON.parse(tc.function.arguments)
      } catch {
        args = { raw: tc.function.arguments }
      }

      // Fallback hard override: extract [Attachment: url=...] annotations from userMessage, force override
      // fields in args that look like file URLs, avoid weak models hallucinating public example URLs (e.g. dummy.pdf)
      //
      // Skip when the tool uses a mounted workspace — those tools take a plain
      // filename (e.g. `resume.pdf`) rather than a URL, and the override would
      // replace the filename with a presigned URL that the tool tries to
      // open() as a local file → guaranteed failure.
      const attachmentUrls = extractAttachmentUrls(userMessage)
      if (attachmentUrls.length > 0 && !endpointInfo?.needsFileMount) {
        const overridden = overrideFileUrlArgs(args, attachmentUrls)
        if (overridden.changed) {
          logger.info('Tool args hard override: replaced with real attachment URLs', {
            toolName: tc.function.name,
            overriddenFields: overridden.fields,
            attachmentUrls,
          })
          args = overridden.args
        }
      }

      let resultContent: string
      const apiEntry = apiTools?.get(tc.function.name)
      if (apiEntry) {
        const apiSpec = apiEntry.spec
        const apiToolForwardIdentity = apiEntry.forwardIdentity ?? false
        const apiToolStart = Date.now()
        try {
          const { runApiTool } = await import('@/lib/tools/api-tool-runner')
          const { buildApiToolDeps } = await import('@/lib/tools/api-tool-deps')
          const r = await runApiTool(apiSpec, args, buildApiToolDeps(), {
            toolId: tc.function.name,
            forwardIdentity: apiToolForwardIdentity,
            identity,
          })
          const durationMs = Date.now() - apiToolStart
          if (r.success) {
            resultContent =
              typeof r.result === 'string' ? r.result : JSON.stringify(r.result, null, 2)
            const toolOutput: Record<string, unknown> = { result: r.result ?? null }
            toolResults.push({
              toolName: tc.function.name,
              toolId: tc.function.name,
              input: args,
              output: toolOutput,
              round,
            })
            await onToolResult?.({
              toolName: tc.function.name,
              toolId: tc.function.name,
              instanceName: tc.function.name,
              input: args,
              output: toolOutput,
              success: true,
              round,
              durationMs,
            })
          } else {
            const errOutput = { error: r.error ?? 'Unknown error' }
            resultContent = `Tool execution failed: ${r.error ?? 'Unknown error'}`
            toolResults.push({
              toolName: tc.function.name,
              toolId: tc.function.name,
              input: args,
              output: errOutput,
              round,
            })
            await onToolResult?.({
              toolName: tc.function.name,
              toolId: tc.function.name,
              instanceName: tc.function.name,
              input: args,
              output: errOutput,
              success: false,
              round,
              durationMs,
            })
          }
        } catch (e) {
          const errMsg = e instanceof Error ? e.message : String(e)
          logger.error('API tool call failed', { toolName: tc.function.name, error: errMsg })
          resultContent = `Tool call failed: ${errMsg}`
          const errOutput = { error: errMsg }
          const durationMs = Date.now() - apiToolStart
          toolResults.push({
            toolName: tc.function.name,
            toolId: tc.function.name,
            input: args,
            output: errOutput,
            round,
          })
          await onToolResult?.({
            toolName: tc.function.name,
            toolId: tc.function.name,
            instanceName: tc.function.name,
            input: args,
            output: errOutput,
            success: false,
            round,
            durationMs,
          })
        }
      } else if (!endpointInfo) {
        resultContent = `Unknown tool: ${tc.function.name}`
        logger.warn(`LLM called unknown tool: ${tc.function.name}`)
      } else {
        logger.info(`[LLM Agent] Tool call started - input parameters`, {
          round: round + 1,
          toolName: tc.function.name,
          toolId: endpointInfo.toolId,
          endpoint: endpointInfo.endpoint,
          input: args,
        })

        // ---- Print tool call input ----
        logger.info('SOP tool call', {
          round: round + 1,
          toolName: tc.function.name,
          toolId: endpointInfo.toolId,
          endpoint: endpointInfo.endpoint,
          input: args,
        })

        // For mounted tools, inject the execution-scoped context the server
        // wrapper needs to compute SOP_WORKDIR / SOP_FILE_URL_PREFIX (the
        // PVC-backed flat layout — see lib/k8s/deploy-skill.ts server
        // wrappers). These fields start with `_` and are stripped by the
        // wrapper before the tool code sees its parameters.
        const requestBody: Record<string, unknown> = { ...args }

        // Platform-injected identity for service/script tools (forwardIdentity).
        // Covers http (service) and opensandbox-script (script reads input.identity).
        if (endpointInfo.forwardIdentity && identity) {
          requestBody.identity = identity
        }

        // Fail-closed: if forwardIdentity is declared but identity is unresolved,
        // reject the tool call now rather than allow unauthorized access.
        if (endpointInfo.forwardIdentity && !identity) {
          const failMsg = 'Tool execution failed: forwardIdentity identity unresolved (fail-closed)'
          logger.warn('Fail-closed: forwardIdentity set but identity unresolved', {
            toolName: tc.function.name,
            toolId: endpointInfo.toolId,
          })
          resultContent = failMsg
          const errOutput = { error: failMsg }
          toolResults.push({
            toolName: tc.function.name,
            toolId: endpointInfo.toolId,
            input: args,
            output: errOutput,
            round,
          })
          await onToolResult?.({
            toolName: tc.function.name,
            toolId: endpointInfo.toolId,
            instanceName: endpointInfo.instanceName,
            input: args,
            output: errOutput,
            success: false,
            round,
            durationMs: 0,
          })
          // Skip the actual fetch/invoke — fall through to message append below
        } else {

        // Generated per-call regardless of needsFileMount so logs can
        // correlate "which invocation" downstream. Tools without file
        // mount just ignore the field.
        const callId = `call_${randomUUID().slice(0, 12)}`
        if (endpointInfo.needsFileMount && sopExecutionId) {
          requestBody._sopExecutionId = sopExecutionId
          // Pre-computed relative path from the sandbox mount root
          // (`/root/io`) to this SOP's file workspace, e.g.
          // `2026/06/01/sop_20260601_xxx`. Tools join it with the bare
          // filename: `f"/root/io/{_sopFileDir}/{name}"`. BFF computes once
          // so tool code doesn't need to parse the date out of the id.
          // Imported locally to avoid a top-level coupling between
          // lib/sop and lib/dev-studio.
          const { paths: devStudioPaths } = await import('@/lib/dev-studio/paths')
          requestBody._sopFileDir = devStudioPaths.sopFiles.relPath(sopExecutionId)
          // Unique-per-invocation id. AI tools MAY use it as a prefix
          // when explicit uniqueness matters (batch generators); BFF
          // also auto-handles same-SOP filename collisions via (N)
          // suffix below.
          requestBody._callId = callId
          if (sopFileUrlPrefix) {
            requestBody._sopFileUrlPrefix = sopFileUrlPrefix
          }
        }

        const toolCallStart = Date.now()
        try {
          let rawJson: Record<string, unknown>

          if (endpointInfo.deployType === 'opensandbox-script') {
            const { invokeScriptTool } = await import('@/lib/tools/script-invoker')
            const userEnv = Object.fromEntries(
              (endpointInfo.envVars ?? []).map((e) => [e.name, String(e.value ?? '')])
            )
            const scriptResult = await invokeScriptTool({
              toolId: endpointInfo.templateId,
              input: requestBody,
              userEnv,
            })
            rawJson = { success: scriptResult.success, result: scriptResult.result, error: scriptResult.error }
          } else {
            const controller = new AbortController()
            const timeout = setTimeout(() => controller.abort(), TOOL_CALL_TIMEOUT_MS)

            const fetchHeaders: Record<string, string> = { 'Content-Type': 'application/json' }
            if (endpointInfo.useProxy) {
              const apiKey = process.env.OPENSANDBOX_API_KEY
              if (apiKey) fetchHeaders['OPEN-SANDBOX-API-KEY'] = apiKey
            }
            const resp = await fetch(endpointInfo.endpoint, {
              method: 'POST',
              headers: fetchHeaders,
              body: JSON.stringify(requestBody),
              signal: controller.signal,
            })
            clearTimeout(timeout)

            if (endpointInfo.deployType === 'opensandbox') {
              // dev-studio service tools (.cmtool) return the user's raw
              // HTTP response — the envelope (success/result/error) is
              // synthesised here at the call boundary, matching
              // app/api/employee/skills/instances/[id]/invoke/route.ts:78
              // and spec-D §D17 graceful-degrade. k8s tools rely on the
              // in-container server wrapper to provide the envelope.
              const respText = await resp.text()
              let respBody: unknown
              try {
                respBody = JSON.parse(respText)
              } catch {
                respBody = { raw: respText }
              }
              rawJson = resp.ok
                ? { success: true, result: respBody }
                : {
                    success: false,
                    error:
                      typeof respBody === 'string' ? respBody : JSON.stringify(respBody),
                  }
            } else {
              rawJson = (await resp.json()) as Record<string, unknown>
            }
          }

          // Same-SOP filename collisions + download_url injection. Two
          // things happen here, in order, only for successful results
          // from file-mount tools:
          //
          //   1. Rename collisions — if a previous tool in this SOP
          //      already wrote a file with the same name, rename the new
          //      file to `<base>(N)<ext>` on disk and update the result's
          //      `output_file` / `output_files` field. AI tools don't
          //      need to coordinate names; BFF picks the suffix.
          //
          //   2. Inject `download_url` / `download_urls` so the LLM never
          //      constructs file URLs from scratch (it used to strip the
          //      `sop_` prefix from execId — see lib/sop/node-executor.ts
          //      File Deliverables block). URLs always reflect the
          //      post-rename names so the link the user clicks resolves
          //      to the right artefact.
          //
          // Both only trigger when sopExecutionId is set (production SOP
          // path); dev-studio test invocations route through
          // sandbox-loader where collisions are confined to one
          // run-test execId and rarely matter.
          if (sopExecutionId && sopFileUrlPrefix) {
            const r = rawJson as { success?: boolean; result?: unknown }
            if (r.success && r.result && typeof r.result === 'object') {
              const inner = r.result as Record<string, unknown>
              const { resolveUniqueName } = await import('./sop-files-workspace')
              const { paths: devStudioPaths } = await import('@/lib/dev-studio/paths')
              const fs = await import('node:fs/promises')
              const path = await import('node:path')
              const sopDir = devStudioPaths.sopFiles.forBff(sopExecutionId)

              // Single output_file (string)
              if (typeof inner.output_file === 'string') {
                const original = inner.output_file
                const finalName = await resolveUniqueName(sopExecutionId, original)
                if (finalName !== original) {
                  try {
                    await fs.rename(
                      path.join(sopDir, original),
                      path.join(sopDir, finalName)
                    )
                    inner.output_file = finalName
                    logger.info('Renamed output file to avoid collision', {
                      sopExecutionId,
                      from: original,
                      to: finalName,
                    })
                  } catch (err) {
                    logger.warn(
                      'Failed to rename colliding output file; keeping original name',
                      {
                        sopExecutionId,
                        original,
                        attemptedFinal: finalName,
                        error: err instanceof Error ? err.message : String(err),
                      }
                    )
                  }
                }
                if (!inner.download_url) {
                  inner.download_url = `${sopFileUrlPrefix}/${encodeURIComponent(
                    inner.output_file as string
                  )}`
                }
              }

              // Multiple output_files (string[])
              if (
                Array.isArray(inner.output_files) &&
                inner.output_files.every((x) => typeof x === 'string')
              ) {
                const originals = inner.output_files as string[]
                const finals: string[] = []
                for (const original of originals) {
                  const finalName = await resolveUniqueName(sopExecutionId, original)
                  if (finalName !== original) {
                    try {
                      await fs.rename(
                        path.join(sopDir, original),
                        path.join(sopDir, finalName)
                      )
                      finals.push(finalName)
                      logger.info('Renamed output file to avoid collision (batch)', {
                        sopExecutionId,
                        from: original,
                        to: finalName,
                      })
                    } catch (err) {
                      logger.warn(
                        'Failed to rename colliding output file in batch; keeping original',
                        {
                          sopExecutionId,
                          original,
                          attemptedFinal: finalName,
                          error: err instanceof Error ? err.message : String(err),
                        }
                      )
                      finals.push(original)
                    }
                  } else {
                    finals.push(original)
                  }
                }
                inner.output_files = finals
                if (!inner.download_urls) {
                  inner.download_urls = finals.map(
                    (name) => `${sopFileUrlPrefix}/${encodeURIComponent(name)}`
                  )
                }
              }
            }
          }

          // Smart files extraction: supports top-level files and files nested in result
          const result = rawJson as {
            success: boolean
            result?: unknown
            error?: string
            files?: Array<{ name: string; mimeType: string; base64: string }>
          }
          if (!result.files || !Array.isArray(result.files) || result.files.length === 0) {
            const nested = result.result as Record<string, unknown> | undefined
            if (
              nested &&
              typeof nested === 'object' &&
              Array.isArray(nested.files) &&
              nested.files.length > 0
            ) {
              result.files = nested.files as Array<{
                name: string
                mimeType: string
                base64: string
              }>
            }
          }

          // ---- Print tool call output ----
          const outputPreview = JSON.stringify(result.result ?? result.error ?? null, null, 2)
          const truncated =
            outputPreview.length > 2000
              ? `${outputPreview.slice(0, 2000)}... (truncated)`
              : outputPreview
          logger.info('SOP tool call result', {
            success: result.success,
            output: truncated,
            ...(result.files && result.files.length > 0
              ? { files: result.files.map((f) => f.name) }
              : {}),
          })

          const durationMs = Date.now() - toolCallStart
          logger.info(`[LLM Agent] Tool call returned - output result`, {
            round: round + 1,
            toolName: tc.function.name,
            toolId: endpointInfo.toolId,
            success: result.success,
            durationMs,
            resultPreview: JSON.stringify(result.result ?? result.error ?? null).slice(0, 500),
            hasFiles: !!(result.files && result.files.length > 0),
            fileCount: result.files?.length ?? 0,
            fileNames: result.files?.map((f) => f.name) ?? [],
          })

          if (result.success) {
            let output: string
            if (typeof result.result === 'string') {
              output = result.result
            } else {
              // Remove base64 content from files when passing to LLM, prevent LLM from outputting raw encoding
              const sanitized = { ...((result.result as Record<string, unknown>) ?? {}) }
              if (Array.isArray(sanitized.files)) {
                sanitized.files = (sanitized.files as Array<Record<string, unknown>>).map((f) => ({
                  name: f.name,
                  mimeType: f.mimeType,
                }))
              }
              output = JSON.stringify(sanitized, null, 2)
            }
            // If files exist, append file list description at text end (without base64)
            if (result.files && result.files.length > 0) {
              const fileList = result.files.map((f) => f.name).join(', ')
              output += `\n\n[${t('sopFileGenerated', undefined, { files: fileList })}]`
            }
            resultContent = output

            // Preserve files field for SOP engine to pass to conversation
            const toolOutput: Record<string, unknown> = { result: result.result ?? null }
            if (result.files && result.files.length > 0) {
              toolOutput.files = result.files
            }

            toolResults.push({
              toolName: tc.function.name,
              toolId: endpointInfo.toolId,
              input: args,
              output: toolOutput,
              round,
            })
            await onToolResult?.({
              toolName: tc.function.name,
              toolId: endpointInfo.toolId,
              instanceName: endpointInfo.instanceName,
              input: args,
              output: toolOutput,
              success: true,
              round,
              durationMs: Date.now() - toolCallStart,
            })
          } else {
            const errOutput = { error: result.error ?? 'Unknown error' }
            resultContent = `Tool execution failed: ${result.error ?? 'Unknown error'}`
            toolResults.push({
              toolName: tc.function.name,
              toolId: endpointInfo.toolId,
              input: args,
              output: errOutput,
              round,
            })
            await onToolResult?.({
              toolName: tc.function.name,
              toolId: endpointInfo.toolId,
              instanceName: endpointInfo.instanceName,
              input: args,
              output: errOutput,
              success: false,
              round,
              durationMs: Date.now() - toolCallStart,
            })
          }
        } catch (e) {
          const errMsg = e instanceof Error ? e.message : String(e)
          logger.error('Tool call failed', { toolId: endpointInfo.toolId, error: errMsg })
          resultContent = `Tool call failed: ${errMsg}`
          const errOutput = { error: errMsg }
          toolResults.push({
            toolName: tc.function.name,
            toolId: endpointInfo.toolId,
            input: args,
            output: errOutput,
            round,
          })
          await onToolResult?.({
            toolName: tc.function.name,
            toolId: endpointInfo.toolId,
            instanceName: endpointInfo.instanceName,
            input: args,
            output: errOutput,
            success: false,
            round,
            durationMs: Date.now() - toolCallStart,
          })
        }
        } // end else (forwardIdentity fail-closed guard)
      }

      // Append tool result message
      messages.push({
        role: 'tool',
        content: resultContent,
        tool_call_id: tc.id,
        name: tc.function.name,
      })
    }

    // Continue loop to let LLM process tool results
  }

  // Max rounds reached, do one final call without tools to get summary
  logger.warn(`[LLM Agent] Max rounds limit reached, forcing end`, {
    maxRounds,
    totalTokens,
    toolResultCount: toolResults.length,
    toolsCalled: toolResults.map((tr) => tr.toolName),
  })
  const maxRoundResult: LLMToolExecutionResult = {
    summary: 'Max tool call rounds reached, execution terminated',
    toolResults,
    rounds: maxRounds,
    totalTokens,
  }

  // Fallback: force-mark error when all tool calls failed
  const fallbackError = detectAllToolsFailed(toolResults)
  if (fallbackError) {
    maxRoundResult.error = fallbackError
  }

  return maxRoundResult
}

/** SOP error prefix marker */
const SOP_ERROR_PREFIX = '[ERROR]'

/**
 * Detect if LLM reply starts with [ERROR] — indicates LLM self-judged unrecoverable error
 */
function detectLLMErrorMarker(content: string | null): string | undefined {
  if (!content) return undefined
  const trimmed = content.trimStart()
  if (trimmed.startsWith(SOP_ERROR_PREFIX)) {
    return (
      trimmed.slice(SOP_ERROR_PREFIX.length).trim() ||
      'Execution error (LLM did not provide details)'
    )
  }
  return undefined
}

/**
 * Extract all URLs from [附件: ...] / [Attachment: ...] annotations.
 * conversation/engine.ts emits the Chinese form ([附件: name=..., url=..., ...]);
 * the English form is kept as a tolerated alias in case other writers add it later.
 */
function extractAttachmentUrls(text: string): string[] {
  if (!text) return []
  const urls: string[] = []
  const annotationRe = /\[(?:附件|Attachment)[::][^\]]+\]/g
  const urlInAnnotationRe = /url=(https?:\/\/[^\s,\]]+)/
  let m: RegExpExecArray | null
  while ((m = annotationRe.exec(text)) !== null) {
    const inner = m[0]
    const u = inner.match(urlInAnnotationRe)
    if (u) urls.push(u[1])
  }
  return urls
}

/**
 * Force override fields in tool args that look like file URLs, replace with real attachment URLs
 * Heuristic: key name contains url/file/pdf/doc/input/attachment (case-insensitive),
 * or value is an http(s) URL, treat as file URL field
 */
function overrideFileUrlArgs(
  args: Record<string, unknown>,
  attachmentUrls: string[]
): { args: Record<string, unknown>; changed: boolean; fields: string[] } {
  if (attachmentUrls.length === 0) {
    return { args, changed: false, fields: [] }
  }
  const FILE_KEY_RE = /url|file|pdf|doc|input|attachment/i
  const next: Record<string, unknown> = { ...args }
  const fields: string[] = []
  let urlIdx = 0
  for (const [key, value] of Object.entries(args)) {
    const valueIsUrl = typeof value === 'string' && /^https?:\/\//.test(value)
    const keyMatches = FILE_KEY_RE.test(key)
    if (!keyMatches && !valueIsUrl) continue
    // Already one of the real attachment URLs, skip
    if (typeof value === 'string' && attachmentUrls.includes(value)) continue
    const replacement = attachmentUrls[Math.min(urlIdx, attachmentUrls.length - 1)]
    next[key] = replacement
    fields.push(key)
    urlIdx++
  }
  return { args: next, changed: fields.length > 0, fields }
}

/**
 * Fallback detection: when tool calls exist and all failed, return aggregated error info
 */
function detectAllToolsFailed(results: ToolResult[]): string | undefined {
  if (results.length === 0) return undefined

  const failedResults = results.filter(
    (r) =>
      r.output && typeof r.output === 'object' && 'error' in (r.output as Record<string, unknown>)
  )

  if (failedResults.length < results.length) return undefined

  // All tool calls failed
  const errors = failedResults.map(
    (r) => `${r.toolName}: ${(r.output as Record<string, unknown>).error}`
  )
  return `All tool calls failed - ${errors.join('; ')}`
}

/**
 * Non-streaming call to OpenAI-compatible LLM API
 */
async function callLLMNonStreaming(
  messages: ChatMessage[],
  tools: OpenAIToolDef[],
  config: ConversationModelConfig
): Promise<ChatCompletionResponse> {
  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    stream: false,
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
    throw new Error(`LLM API error (${response.status}): ${errorText.slice(0, 300)}`)
  }

  return response.json() as Promise<ChatCompletionResponse>
}
