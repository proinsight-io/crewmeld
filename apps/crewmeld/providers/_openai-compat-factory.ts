/**
 * @file OpenAI-compatible provider factory.
 *
 * Produces a {@link ProviderConfig} for any LLM endpoint that speaks the
 * OpenAI Chat Completions wire format (Moonshot, Zhipu, ByteDance Volcano Ark,
 * MiniMax, etc.).  Consumers call {@link createOpenAICompatibleProvider} and
 * get back a ready-to-use provider object.
 */

import { createLogger } from '@crewmeld/logger'
import OpenAI from 'openai'
import { executeTool } from '@/lib/tools/execute-custom-skill'
import type { StreamingExecution } from '@/lib/types/execution'
import type {
  FunctionCallResponse,
  ProviderConfig,
  ProviderRequest,
  ProviderResponse,
  TimeSegment,
} from '@/providers/types'
import { ProviderError } from '@/providers/types'
import {
  calculateCost,
  createOpenAICompatibleStream,
  prepareToolExecution,
  prepareToolsWithUsageControl,
  trackForcedToolUsage,
} from '@/providers/utils'

// ─── Options ──────────────────────────────────────────────────────────────────

/** Configuration bundle for {@link createOpenAICompatibleProvider}. */
export interface OpenAICompatProviderOptions {
  id: string
  name: string
  description: string
  /** Default API base URL (user may override via config). */
  defaultBaseURL: string
  /** Placeholder model ID shown in the form; user can substitute another. */
  defaultModel: string
  /** Enumerated model list (may be empty). */
  models?: string[]
  /** Label used in log messages. */
  logPrefix: string
  version?: string
}

// ─── Internal types ────────────────────────────────────────────────────────────

/** Running totals for prompt / completion / combined token usage. */
interface TokenBudget {
  input: number
  output: number
  total: number
}

/** Mutable execution state threaded through the tool-call loop. */
interface LoopState {
  reply: OpenAI.Chat.Completions.ChatCompletion
  content: string
  budget: TokenBudget
  gathered: FunctionCallResponse[]
  outputs: unknown[]
  history: Array<Record<string, unknown>>
  loopIndex: number
  forcedUsed: string[]
  activatedForced: boolean
  wallModelMs: number
  wallToolMs: number
  firstMs: number
  trace: TimeSegment[]
}

/** Typed carrier for a single resolved tool invocation. */
interface InvocationRecord {
  tc: OpenAI.Chat.Completions.ChatCompletionMessageToolCall
  toolName: string
  toolParams: Record<string, unknown>
  outcome: { success: boolean; output?: unknown; error?: string }
  began: number
  finished: number
  elapsed: number
}

// ─── Error classification ─────────────────────────────────────────────────────

type ErrorKind = 'quota' | 'connectivity' | 'unknown'

/** Regex patterns used to detect quota and connectivity errors. */
const ERR_QUOTA_RE = /rate[ _-]?limit/i
const ERR_NET_RE = /\b(timeout|ETIMEDOUT|ECONNRESET|ENOTFOUND)\b/i
/** String sentinel returned by {@link classifyError} for quota exhaustion. */
const KIND_QUOTA: ErrorKind = 'quota'
/** String sentinel returned by {@link classifyError} for network failures. */
const KIND_CONNECTIVITY: ErrorKind = 'connectivity'

function classifyError(msg: string): ErrorKind {
  if (msg.includes('429') || ERR_QUOTA_RE.test(msg) || msg.includes('Too Many Requests'))
    return KIND_QUOTA
  if (ERR_NET_RE.test(msg)) return KIND_CONNECTIVITY
  return 'unknown'
}

// ─── Timing helpers ───────────────────────────────────────────────────────────

/** Returns a snapshot ISO timestamp for the current moment. */
const snapIso = (): string => new Date().toISOString()

/** Returns elapsed milliseconds since a start epoch. */
const elapsedMs = (since: number): number => Date.now() - since

/** Builds a {@link TimeSegment} entry. */
function mkSegment(
  kind: TimeSegment['type'],
  label: string,
  startEpoch: number,
  durationMs: number
): TimeSegment {
  return {
    type: kind,
    name: label,
    startTime: startEpoch,
    endTime: startEpoch + durationMs,
    duration: durationMs,
  }
}

// ─── Accumulator ──────────────────────────────────────────────────────────────

/** Mutable counter that accumulates prompt/completion/total token usage across iterations. */
class TokenAccumulator {
  constructor(
    public ingested = 0,
    public emitted = 0,
    public combined = 0
  ) {}

  absorb(usage: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }): void {
    this.ingested += usage.prompt_tokens ?? 0
    this.emitted += usage.completion_tokens ?? 0
    this.combined += usage.total_tokens ?? 0
  }

  toBudget(): TokenBudget {
    return { input: this.ingested, output: this.emitted, total: this.combined }
  }
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────

/** Strips markdown code-fence wrappers from model-returned text. */
const trimFences = (raw: string): string => raw.replace(/```json\n?|\n?```/g, '').trim()

/** Converts `request.tools` into the OpenAI function-calling schema. */
function toFunctionDefs(
  req: ProviderRequest
):
  | Array<{ type: string; function: { name: string; description: string; parameters: unknown } }>
  | undefined {
  return req.tools?.length
    ? req.tools.map((t) => ({
        type: 'function',
        function: { name: t.id, description: t.description, parameters: t.parameters },
      }))
    : undefined
}

/** Produces the chronologically-ordered message list for the initial call. */
function buildInitialHistory(req: ProviderRequest): Array<Record<string, unknown>> {
  const msgs: Array<Record<string, unknown>> = []
  if (req.systemPrompt) msgs.push({ role: 'system', content: req.systemPrompt })
  if (req.context) msgs.push({ role: 'user', content: req.context })
  if (req.messages) msgs.push(...(req.messages as unknown as Array<Record<string, unknown>>))
  return msgs
}

/** Wraps a streaming response into the {@link StreamingExecution} shape. */
function wrapStream(
  raw: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>,
  logPrefix: string,
  req: ProviderRequest,
  startMs: number,
  startIso: string,
  baseTokens?: TokenBudget,
  gathered?: FunctionCallResponse[],
  trace?: TimeSegment[],
  wallModelMs?: number,
  wallToolMs?: number,
  firstMs?: number,
  loopRounds?: number
): StreamingExecution {
  const prior = baseTokens ?? { input: 0, output: 0, total: 0 }
  const priorCost = baseTokens
    ? calculateCost(req.model, prior.input, prior.output)
    : { input: 0, output: 0, total: 0 }
  const isPostTool = baseTokens !== undefined

  const env = {
    stream: null as unknown as ReadableStream,
    execution: {
      success: true,
      output: {
        content: '',
        model: req.model,
        tokens: { ...prior },
        toolCalls: gathered?.length ? { list: gathered, count: gathered.length } : undefined,
        providerTiming: {
          startTime: startIso,
          endTime: new Date().toISOString(),
          duration: Date.now() - startMs,
          ...(isPostTool
            ? {
                modelTime: wallModelMs,
                toolsTime: wallToolMs,
                firstResponseTime: firstMs,
                iterations: (loopRounds ?? 0) + 1,
                timeSegments: trace,
              }
            : {
                timeSegments: [
                  {
                    type: 'model' as const,
                    name: 'Streaming response',
                    startTime: startMs,
                    endTime: Date.now(),
                    duration: Date.now() - startMs,
                  },
                ],
              }),
        },
        cost: { input: priorCost.input, output: priorCost.output, total: priorCost.total },
      },
      logs: [] as unknown[],
      metadata: {
        startTime: startIso,
        endTime: new Date().toISOString(),
        duration: Date.now() - startMs,
      },
      isStreaming: true,
    },
  }

  env.stream = createOpenAICompatibleStream(raw, logPrefix, (finalTxt, usage) => {
    env.execution.output.content = finalTxt
    env.execution.output.tokens = {
      input: prior.input + usage.prompt_tokens,
      output: prior.output + usage.completion_tokens,
      total: prior.total + usage.total_tokens,
    }
    const c = calculateCost(req.model, usage.prompt_tokens, usage.completion_tokens)
    env.execution.output.cost = {
      input: priorCost.input + c.input,
      output: priorCost.output + c.output,
      total: priorCost.total + c.total,
    }
  })

  return env as unknown as StreamingExecution
}

/** Picks the `tool_choice` override to use for the next model call during pinned-tool sequencing. */
function pickNextToolChoice(
  original: unknown,
  activated: boolean,
  pinnedList: string[],
  spentList: string[]
): unknown {
  if (typeof original !== 'object' || !activated || !pinnedList.length) return undefined
  const remaining = pinnedList.filter((n) => !spentList.includes(n))
  return remaining.length ? { type: 'function', function: { name: remaining[0] } } : 'auto'
}

// ─── Tool invocation batch ────────────────────────────────────────────────────

/**
 * Builds the assistant history turn that declares which tool calls were made.
 * Must be appended before the corresponding tool-result turns.
 */
function assistantTurn(
  declarations: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[]
): Record<string, unknown> {
  return {
    role: 'assistant',
    content: null,
    tool_calls: declarations.map((slotId) => ({
      id: slotId.id,
      type: 'function',
      function: { name: slotId.function.name, arguments: slotId.function.arguments },
    })),
  }
}

/** Executes all pending tool calls concurrently and returns settled records. */
async function dispatchToolBatch(
  invocations: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[],
  req: ProviderRequest,
  log: ReturnType<typeof createLogger>
): Promise<Array<PromiseSettledResult<InvocationRecord | null>>> {
  return Promise.allSettled(
    invocations.map(async (tc): Promise<InvocationRecord | null> => {
      const began = Date.now()
      const fnName = tc.function.name
      try {
        const args = JSON.parse(tc.function.arguments)
        const matched = req.tools?.find((t) => t.id === fnName)
        if (!matched) return null
        const { toolParams: callArgs, executionParams } = prepareToolExecution(matched, args, req)
        const callResult = await executeTool(fnName, executionParams)
        const finished = Date.now()
        return {
          tc,
          toolName: fnName,
          toolParams: callArgs as Record<string, unknown>,
          outcome: callResult,
          began,
          finished,
          elapsed: finished - began,
        }
      } catch (err) {
        const finished = Date.now()
        log.error('Tool dispatch error:', { error: err, fnName })
        return {
          tc,
          toolName: fnName,
          toolParams: {},
          began,
          finished,
          elapsed: finished - began,
          outcome: {
            success: false,
            output: undefined,
            error: err instanceof Error ? err.message : 'Tool execution failed',
          },
        }
      }
    })
  )
}

/** Folds settled tool-invocation records into the running loop state. */
function foldInvocations(
  settled: Array<PromiseSettledResult<InvocationRecord | null>>,
  state: LoopState
): void {
  for (const s of settled) {
    if (s.status === 'rejected' || !s.value) continue
    const { tc, toolName, toolParams, outcome, began, finished, elapsed } = s.value
    state.trace.push({
      type: 'tool',
      name: toolName,
      startTime: began,
      endTime: finished,
      duration: elapsed,
    })

    const payload: Record<string, unknown> = outcome.success
      ? ((outcome.output ?? {}) as Record<string, unknown>)
      : { error: true, message: outcome.error ?? 'Tool execution failed', tool: toolName }

    if (outcome.success) state.outputs.push(outcome.output)

    state.gathered.push({
      name: toolName,
      arguments: toolParams,
      startTime: new Date(began).toISOString(),
      endTime: new Date(finished).toISOString(),
      duration: elapsed,
      result: payload,
      success: outcome.success,
    })

    state.history.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(payload) })
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Builds a complete {@link ProviderConfig} for an OpenAI-compatible endpoint.
 *
 * @param opts - Provider-specific parameters.
 * @returns A ready-to-register provider configuration.
 */
export function createOpenAICompatibleProvider(opts: OpenAICompatProviderOptions): ProviderConfig {
  const log = createLogger(`${opts.logPrefix}Provider`)

  async function executeRequest(
    req: ProviderRequest
  ): Promise<ProviderResponse | StreamingExecution> {
    // In E2E mock mode, MSW intercepts outbound HTTP so no real API key is needed.
    // Use a placeholder to allow the provider to proceed past the key guard.
    const effectiveApiKey =
      req.apiKey ?? (process.env.E2E_MOCK_SERVER === '1' ? 'e2e-mock-key' : undefined)
    if (!effectiveApiKey) throw new Error(`${opts.name} requires an API Key`)

    const t0 = Date.now()
    const t0Iso = new Date(t0).toISOString()

    try {
      // Per-request endpoint override (custom "API endpoint" from the model config)
      // wins over the provider's static default; unset falls back to the default.
      const baseURL = req.apiEndpoint?.trim() || opts.defaultBaseURL
      const client = new OpenAI({ apiKey: effectiveApiKey, baseURL })
      const initialHistory = buildInitialHistory(req)
      const fnDefs = toFunctionDefs(req)

      const baseBody: Record<string, unknown> = { model: req.model, messages: initialHistory }
      if (req.temperature !== undefined) baseBody.temperature = req.temperature
      if (req.maxTokens != null) baseBody.max_tokens = req.maxTokens

      let preparedTools: ReturnType<typeof prepareToolsWithUsageControl> | null = null
      if (fnDefs?.length) {
        preparedTools = prepareToolsWithUsageControl(fnDefs, req.tools, log, opts.id)
        const { tools: active, toolChoice } = preparedTools
        if (active?.length && toolChoice) {
          baseBody.tools = active
          baseBody.tool_choice = toolChoice
        }
      }

      const castBase =
        baseBody as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming

      // ── Fast path: streaming with no tools ───────────────────────────────
      if (req.stream && !fnDefs?.length) {
        log.info(`Using streaming response for ${opts.name} request (no tools)`)
        const sr = await client.chat.completions.create({ ...castBase, stream: true })
        return wrapStream(
          sr as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>,
          opts.logPrefix,
          req,
          t0,
          t0Iso
        )
      }

      // ── Initial (non-streaming) call ──────────────────────────────────────
      const callT0 = Date.now()
      const originalChoice = baseBody.tool_choice
      const forcedSet = preparedTools?.forcedTools ?? []

      const initialReply = await client.chat.completions.create(castBase)
      const firstMs = Date.now() - callT0

      const accumulator = new TokenAccumulator()
      if (initialReply.usage) accumulator.absorb(initialReply.usage)

      const initContent = initialReply.choices[0]?.message?.content ?? ''
      const state: LoopState = {
        reply: initialReply,
        content: initContent ? trimFences(initContent) : '',
        budget: accumulator.toBudget(),
        gathered: [],
        outputs: [],
        history: [...initialHistory],
        loopIndex: 0,
        forcedUsed: [],
        activatedForced: false,
        wallModelMs: firstMs,
        wallToolMs: 0,
        firstMs,
        trace: [mkSegment('model', 'Initial response', callT0, firstMs)],
      }

      // Seed forced-tool tracking
      if (typeof originalChoice === 'object' && initialReply.choices[0]?.message?.tool_calls) {
        const tracked = trackForcedToolUsage(
          initialReply.choices[0].message.tool_calls,
          originalChoice,
          log,
          opts.id,
          forcedSet,
          state.forcedUsed
        )
        state.activatedForced = tracked.hasUsedForcedTool
        state.forcedUsed = tracked.usedForcedTools
      }

      // ── Tool loop ─────────────────────────────────────────────────────────
      try {
        while (state.loopIndex < 20) {
          const latestText = state.reply.choices[0]?.message?.content
          if (latestText) state.content = latestText

          const pending = state.reply.choices[0]?.message?.tool_calls
          if (!pending?.length) break

          const batchT0 = Date.now()
          const settled = await dispatchToolBatch(pending, req, log)

          // Append assistant turn declaring the tool calls
          state.history.push(assistantTurn(pending))

          foldInvocations(settled, state)
          state.wallToolMs += Date.now() - batchT0

          // Build next request body with updated history + tool choice
          const nextBody: Record<string, unknown> = { ...baseBody, messages: state.history }
          const nextChoice = pickNextToolChoice(
            originalChoice,
            state.activatedForced,
            forcedSet,
            state.forcedUsed
          )
          if (nextChoice !== undefined) nextBody.tool_choice = nextChoice

          const mT0 = Date.now()
          state.reply = await client.chat.completions.create(
            nextBody as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming
          )
          const mElapsed = elapsedMs(mT0)

          if (
            typeof nextBody.tool_choice === 'object' &&
            state.reply.choices[0]?.message?.tool_calls
          ) {
            const tracked = trackForcedToolUsage(
              state.reply.choices[0].message.tool_calls,
              nextBody.tool_choice,
              log,
              opts.id,
              forcedSet,
              state.forcedUsed
            )
            state.activatedForced = tracked.hasUsedForcedTool
            state.forcedUsed = tracked.usedForcedTools
          }

          state.trace.push(
            mkSegment('model', `Model response (iteration ${state.loopIndex + 1})`, mT0, mElapsed)
          )
          state.wallModelMs += mElapsed

          const iterText = state.reply.choices[0]?.message?.content
          if (iterText) state.content = trimFences(iterText)

          if (state.reply.usage) {
            accumulator.absorb(state.reply.usage)
            state.budget = accumulator.toBudget()
          }

          state.loopIndex++
        }
      } catch (loopErr) {
        log.error(`${opts.name} tool loop error:`, { error: loopErr })
      }

      // ── Post-loop streaming path ───────────────────────────────────────────
      if (req.stream) {
        log.info(`Using streaming for final ${opts.name} response after tool processing`)
        const sr = await client.chat.completions.create({
          ...castBase,
          messages:
            state.history as unknown as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
          tool_choice: 'auto',
          stream: true,
        })
        return wrapStream(
          sr as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>,
          opts.logPrefix,
          req,
          t0,
          t0Iso,
          state.budget,
          state.gathered,
          state.trace,
          state.wallModelMs,
          state.wallToolMs,
          state.firstMs,
          state.loopIndex
        )
      }

      // ── Non-streaming result ───────────────────────────────────────────────
      const tEnd = Date.now()
      return {
        content: state.content,
        model: req.model,
        tokens: state.budget,
        toolCalls: state.gathered.length ? state.gathered : undefined,
        toolResults: state.outputs.length ? state.outputs : undefined,
        timing: {
          startTime: t0Iso,
          endTime: new Date(tEnd).toISOString(),
          duration: tEnd - t0,
          modelTime: state.wallModelMs,
          toolsTime: state.wallToolMs,
          firstResponseTime: state.firstMs,
          iterations: state.loopIndex + 1,
          timeSegments: state.trace,
        },
      }
    } catch (err) {
      const tErr = Date.now()
      const tErrIso = new Date(tErr).toISOString()
      const dur = tErr - t0
      const msg = err instanceof Error ? err.message : String(err)
      const kind = classifyError(msg)

      if (kind === KIND_QUOTA) {
        log.error(`${opts.name} rate limit exceeded`, { message: msg, duration: dur })
        throw new ProviderError(`Rate limit exceeded, please try again later (${msg})`, {
          startTime: t0Iso,
          endTime: tErrIso,
          duration: dur,
        })
      }
      if (kind === KIND_CONNECTIVITY) {
        log.error(`${opts.name} network error`, { message: msg, duration: dur })
        throw new ProviderError(`Network error: ${msg}`, {
          startTime: t0Iso,
          endTime: tErrIso,
          duration: dur,
        })
      }
      log.error(`Error in ${opts.name} request:`, { error: err, message: msg, duration: dur })
      throw new ProviderError(msg, { startTime: t0Iso, endTime: tErrIso, duration: dur })
    }
  }

  return {
    id: opts.id,
    name: opts.name,
    description: opts.description,
    version: opts.version ?? '1.0.0',
    models: opts.models ?? [],
    defaultModel: opts.defaultModel,
    executeRequest,
  }
}
