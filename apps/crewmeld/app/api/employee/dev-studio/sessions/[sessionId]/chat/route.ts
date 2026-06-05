/**
 * POST /api/employee/dev-studio/sessions/:sessionId/chat
 *
 * Sub-spec B Phase 6: forwards user chat to claude-code-webui inside the
 * sandbox and orchestrates all streaming signals on the way back:
 *
 *  - Drains queued system notes (set by /dependencies/reject and /answer-ask)
 *    and prepends them to `message` before forwarding so the AI sees them as
 *    in-band instructions on its next turn.
 *  - Runs four extractors over every assistant_text frame:
 *      MarkerExtractor      — `<pipeline>`, `<phase>`, `<title>`
 *      AskExtractor         — `<ask>` HITL prompts
 *      detectPhase          — heuristic fallback when no `<phase>` ever fires
 *      FileActivityDetector — Write/manifest/README signals (best-effort log;
 *                             SSE channel is stubbed in B and the UI tails via
 *                             SWR /manifest /readme)
 *  - Persists every NDJSON frame to `tool_dev_messages` with a monotonically
 *    increasing `sequence`; persistence is fire-and-forget so a DB hiccup does
 *    not break the live stream.
 *  - On `result` frames, accumulates `totalInputTokens` / `totalOutputTokens`
 *    on the session row and bumps `lastActiveAt`.
 *  - Toggles `sessionStore.markStreaming(id, true)` synchronously before
 *    handing the response back and flips it back to `false` from a tail
 *    TransformStream `flush` hook so concurrent /chat requests can see the
 *    accurate streaming flag.
 *
 * Security: `workingDirectory` is ALWAYS overridden to `/root/workspace`,
 * regardless of what (if anything) the client tried to send. The Zod schema
 * rejects requests containing the field at all (strict() mode).
 *
 * Auth + ownership: cross-user lookups return 404 (no info leak), matching
 * sibling routes. A 409 surfaces when the session has no active container —
 * the caller must hit /rehydrate first.
 */

import { db, toolDevMessages, toolDevPendingActions } from '@crewmeld/db'
import { createLogger } from '@crewmeld/logger'
import { and, desc, eq } from 'drizzle-orm'
import { getCurrentUserRole } from '@/lib/auth/rbac/check-role'
import { AskExtractor } from '@/lib/dev-studio/ask-extractor'
import { getDevStudioEnv } from '@/lib/dev-studio/env'
import { FileActivityDetector } from '@/lib/dev-studio/file-activity-detector'
import { OpenSandboxClient } from '@/lib/dev-studio/opensandbox-client'
import { detectPhase } from '@/lib/dev-studio/phase-detector'
import { MarkerExtractor } from '@/lib/dev-studio/phase-marker-extractor'
import { mergePipelineUnion } from '@/lib/dev-studio/pipeline-union'
import type { ContentBlock, SDKMessage } from '@/lib/dev-studio/schemas'
import { ChatRequestSchema } from '@/lib/dev-studio/schemas'
import type { SessionRecord } from '@/lib/dev-studio/session-store'
import { sessionStore } from '@/lib/dev-studio/session-store'
import { createNDJSONInterceptor } from '@/lib/dev-studio/webui-proxy'
import { resolveLocale } from '@/lib/i18n/server-locale'
import { messages as locales } from '@/locales'

const log = createLogger('dev-studio:chat')

interface RouteContext {
  params: Promise<{ sessionId: string }>
}

type MessageKind = 'user' | 'assistant_text' | 'tool_use' | 'tool_result' | 'system' | 'result'

/**
 * Make sure the AI-supplied pipeline always ends with the synthetic
 * "adoption" step that the UI uses as a terminal handoff. The AI is allowed
 * to include it explicitly; we only append when missing.
 */
function ensureAdoptionLast(phases: string[]): string[] {
  if (phases.length > 0 && phases[phases.length - 1] === 'adoption') return phases
  return [...phases, 'adoption']
}

/**
 * Read the content blocks out of an SDK envelope.
 *
 * The real Claude SDK nests blocks under `msg.message.content` (Anthropic API
 * shape). Older fixtures put them at the top level under `msg.content`. We
 * check the envelope first and fall back to the top level so both shapes
 * keep working — earlier revisions of this file only read the top level and
 * silently dropped every real assistant payload, which is what broke the
 * marker / ask / file-activity extractors in production despite all unit
 * tests passing on the legacy fixture shape.
 */
function getContent(msg: SDKMessage): ContentBlock[] {
  const env = msg.message
  if (env && typeof env === 'object' && Array.isArray(env.content)) {
    return env.content as ContentBlock[]
  }
  return Array.isArray(msg.content) ? (msg.content as ContentBlock[]) : []
}

/** Whether the content blocks live under the message envelope (vs top level). */
function isEnvelopeContent(msg: SDKMessage): boolean {
  const env = msg.message
  return !!(env && typeof env === 'object' && Array.isArray(env.content))
}

/**
 * Classify an SDK envelope into the kind enum stored in `tool_dev_messages`.
 *
 * - `result` frames map straight to `'result'`.
 * - `assistant` frames are split by leading content block: `tool_use` wins over
 *   text; the absence of either falls back to `'assistant_text'` so we never
 *   drop the row.
 * - `user` frames containing a `tool_result` block become `'tool_result'`.
 */
function classifyKind(msg: SDKMessage): MessageKind {
  if (msg.type === 'result') return 'result'
  if (msg.type === 'system') return 'system'
  const content = getContent(msg)
  if (msg.type === 'assistant') {
    for (const block of content) {
      if (block.type === 'tool_use') return 'tool_use'
    }
    return 'assistant_text'
  }
  if (msg.type === 'user') {
    for (const block of content) {
      if (block.type === 'tool_result') return 'tool_result'
    }
    return 'user'
  }
  return 'assistant_text'
}

/** Pull the first text block's `text` field out of an SDKMessage, if any. */
function extractAssistantText(msg: SDKMessage): string | null {
  if (msg.type !== 'assistant') return null
  for (const block of getContent(msg)) {
    if (block.type === 'text' && typeof (block as { text?: unknown }).text === 'string') {
      return (block as { text: string }).text
    }
  }
  return null
}

/**
 * Replace the first text block's `text` with a cleaned variant (markers /
 * asks stripped). Returns a shallow-cloned message so the original frame
 * captured for persistence is left intact. The cleaned content is written
 * back to whichever location it was read from (envelope vs top level) so
 * the frame the UI receives keeps its original shape.
 */
function withCleanedText(msg: SDKMessage, cleaned: string): SDKMessage {
  if (msg.type !== 'assistant') return msg
  const content = getContent(msg)
  let replaced = false
  const nextContent = content.map((block) => {
    if (!replaced && block.type === 'text') {
      replaced = true
      return { ...(block as object), text: cleaned } as ContentBlock
    }
    return block
  })
  if (isEnvelopeContent(msg)) {
    const env = msg.message as { content: ContentBlock[]; [key: string]: unknown }
    return { ...msg, message: { ...env, content: nextContent } }
  }
  return { ...msg, content: nextContent }
}

/**
 * SELECT MAX(sequence) for a session via Drizzle's high-level builder so the
 * databaseMock-based unit tests can intercept it. Falls back to 0 when the
 * session has no messages yet or the query returns null.
 */
async function loadMaxSequence(sessionId: string): Promise<number> {
  try {
    const rows = await db
      .select({ sequence: toolDevMessages.sequence })
      .from(toolDevMessages)
      .where(eq(toolDevMessages.sessionId, sessionId))
      .orderBy(desc(toolDevMessages.sequence))
      .limit(1)
    const row = rows[0] as { sequence?: number; max?: number } | undefined
    const value = row?.sequence ?? row?.max
    return typeof value === 'number' ? value : 0
  } catch (e) {
    log.warn('failed to load max(sequence); restarting at 0', { err: String(e), sessionId })
    return 0
  }
}

/**
 * Append a synthetic "user" frame to the timeline so the persisted log starts
 * with the exact prompt that was forwarded upstream (after system-note
 * prepend). The webui only emits assistant / tool / result frames, so this is
 * the only place the user side of the conversation enters the table.
 */
function buildUserFrame(message: string): SDKMessage {
  return {
    type: 'user',
    content: [{ type: 'text', text: message } as ContentBlock],
  }
}

/**
 * Fire-and-forget persistence — never lets a DB error bubble into the stream.
 */
function persistMessage(
  sessionId: string,
  sequence: number,
  kind: MessageKind,
  payload: SDKMessage
): void {
  Promise.resolve(
    db.insert(toolDevMessages).values({
      sessionId,
      sequence,
      kind,
      payload,
    })
  ).catch((err) => {
    log.warn('failed to persist dev-studio message; stream continues', {
      err: String(err),
      sessionId,
      sequence,
      kind,
    })
  })
}

/**
 * Fire-and-forget pending-action insert. A unique-index violation (same askId
 * already queued) is logged at debug level rather than treated as an error;
 * it just means the AI re-emitted the same ask in the same turn.
 */
function persistPendingAction(
  sessionId: string,
  askId: string,
  type: 'choice' | 'confirm' | 'text',
  payload: unknown
): void {
  Promise.resolve(
    db.insert(toolDevPendingActions).values({
      sessionId,
      askId,
      type,
      payload,
      status: 'pending',
    })
  ).catch((err) => {
    log.warn('failed to persist pending ask; UI will rely on SWR refetch', {
      err: String(err),
      sessionId,
      askId,
      type,
    })
  })
}

/**
 * Fire-and-forget session patch — keeps the stream lively even when the DB
 * blips. The error is logged so ops can spot drift; on the next /chat call
 * the persisted phase / token totals will catch up from whichever fields did
 * land.
 */
function applySessionPatch(sessionId: string, patch: Record<string, unknown>): void {
  Promise.resolve(sessionStore.update(sessionId, patch)).catch((err) => {
    log.warn('failed to patch session row; stream continues', {
      err: String(err),
      sessionId,
      keys: Object.keys(patch),
    })
  })
}

/**
 * Transformer with a `cancel` hook. The WHATWG Streams spec defines this
 * callback (fired when the readable side is cancelled — e.g. the browser tab
 * closes and Next.js aborts the response), but TypeScript's lib.dom.d.ts
 * 5.9.x has not picked it up yet. We narrow the type locally rather than
 * leaking `any` into the pipeline.
 */
type TransformerWithCancel<I, O> = Transformer<I, O> & {
  cancel?: (reason: unknown) => void | PromiseLike<void>
}

/**
 * TransformStream tail that fires `sessionStore.markStreaming(false)` once
 * the pipeline unwinds. Sits at the very end of the chain so it runs whether
 * the upstream completes normally, the client aborts mid-stream (`cancel`),
 * or an interceptor errors (`flush` after the readable closes).
 *
 * Per the Streams spec, `ReadableStream.cancel()` invokes the transformer's
 * `cancel` hook, NOT `flush`. We therefore wire BOTH paths to the same
 * `clearOnce` closure so a real client disconnect cannot leave the session
 * stuck in `streaming=true` until process restart.
 */
function createStreamingLifecycleTail(sessionId: string): TransformStream<Uint8Array, Uint8Array> {
  let cleared = false
  const clearOnce = () => {
    if (cleared) return
    cleared = true
    try {
      sessionStore.markStreaming(sessionId, false)
    } catch (err) {
      log.warn('failed to clear streaming flag', { err: String(err), sessionId })
    }
  }
  const transformer: TransformerWithCancel<Uint8Array, Uint8Array> = {
    transform(chunk, controller) {
      controller.enqueue(chunk)
    },
    flush() {
      clearOnce()
    },
    cancel(_reason) {
      clearOnce()
    },
  }
  return new TransformStream(transformer)
}

export async function POST(req: Request, ctx: RouteContext): Promise<Response> {
  const { sessionId } = await ctx.params

  const auth = await getCurrentUserRole()
  if (!auth.authenticated || !auth.userId) {
    return new Response('Unauthorized', { status: 401 })
  }

  const session = (await sessionStore.get(sessionId)) as SessionRecord | null
  if (!session || session.userId !== auth.userId) {
    return new Response('Not Found', { status: 404 })
  }
  if (!session.activeContainerId) {
    return new Response(
      JSON.stringify({
        error: 'no-active-container',
        detail: 'Session has no live container; call /rehydrate first.',
        retryable: false,
      }),
      { status: 409, headers: { 'content-type': 'application/json' } }
    )
  }

  const raw = await req.json().catch(() => null)
  const parsed = ChatRequestSchema.safeParse(raw)
  if (!parsed.success) {
    return new Response(
      JSON.stringify({ error: 'bad-request', detail: parsed.error.message, retryable: false }),
      { status: 400, headers: { 'content-type': 'application/json' } }
    )
  }

  // Drain queued system notes BEFORE forwarding so the AI sees them as
  // in-band instructions on this turn. Notes today are <answer id="..."> tags
  // emitted by /answer-ask; future kinds (container expired, etc.) drop in
  // here too. We wrap them in a short imperative envelope so the model knows
  // this is not freeform user prose — it's the answer to its previous <ask>
  // and it should advance the workflow instead of repeating the question.
  const notes = sessionStore.drainSystemNotes(sessionId)

  // DB fallback: the in-process queue can be lost on HMR or module reload.
  // Check for answered-but-unconsumed pending actions in the DB and promote
  // them into notes, then mark them expired so they're not consumed twice.
  if (notes.length === 0) {
    try {
      const answered = await db
        .select()
        .from(toolDevPendingActions)
        .where(
          and(
            eq(toolDevPendingActions.sessionId, sessionId),
            eq(toolDevPendingActions.status, 'answered')
          )
        )
      for (const row of answered) {
        const val = row.answer && typeof row.answer === 'object' && 'value' in (row.answer as Record<string, unknown>)
          ? (row.answer as { value: unknown }).value
          : row.answer
        notes.push(`<answer id="${row.askId}">${JSON.stringify(val)}</answer>`)
        await db
          .update(toolDevPendingActions)
          .set({ status: 'expired' })
          .where(eq(toolDevPendingActions.id, row.id))
      }
    } catch (e) {
      log.warn('failed to drain answered pending actions from DB', { err: String(e), sessionId })
    }
  }

  const uploadNotices = sessionStore.drainUploadNotices(sessionId)

  log.info('chat: drained system notes', {
    sessionId,
    count: notes.length,
    notes,
    uploadCount: uploadNotices.length,
    userMessagePreview: parsed.data.message.slice(0, 120),
  })

  // Compose the in-band envelope. The two queues are independent — an upload
  // can land between an ask answer and the next user message, or vice versa.
  // Inject text is locale-routed (zh-CN | en) so the AI's first-message
  // persona language (see lib/dev-studio/persona-extensions.ts) and these
  // mid-stream nudges stay consistent — both follow the operator's UI locale.
  const inject = locales[resolveLocale(req)].devStudio.inject
  const segments: string[] = []
  if (notes.length > 0) {
    segments.push(inject.askAnswered, ...notes)
  }
  if (uploadNotices.length > 0) {
    const list = uploadNotices
      .map((u) => `- /root/workspace/upload/${u.filename} (${u.size} bytes)`)
      .join('\n')
    segments.push(inject.uploadsHeader, list)
  }
  if (segments.length > 0) segments.push('')
  segments.push(parsed.data.message)
  const userMessage = segments.join('\n')

  let env: ReturnType<typeof getDevStudioEnv>
  try {
    env = getDevStudioEnv()
  } catch (e) {
    return new Response(
      JSON.stringify({ error: 'config-missing', detail: String(e), retryable: false }),
      { status: 503, headers: { 'content-type': 'application/json' } }
    )
  }

  const client = new OpenSandboxClient({
    serverUrl: env.OPENSANDBOX_SERVER_URL,
    apiKey: env.OPENSANDBOX_API_KEY,
    useProxy: env.OPENSANDBOX_USE_PROXY,
  })

  // Fire-and-forget renew so chat latency doesn't compound with sandbox TTL ops.
  client.renew(session.activeContainerId, env.CREWMELD_SANDBOX_TTL_SECONDS).catch(() => {})

  let webuiUrl: string
  try {
    webuiUrl = await client.getEndpoint(session.activeContainerId, 8080)
  } catch (e) {
    return new Response(
      JSON.stringify({ error: 'sandbox-unreachable', detail: String(e), retryable: true }),
      { status: 502, headers: { 'content-type': 'application/json' } }
    )
  }

  // Mark streaming BEFORE the upstream call — concurrent /chat requests look
  // at this flag synchronously and we want them to see the contention.
  sessionStore.markStreaming(sessionId, true)

  // Track running totals in closure scope so multiple result frames in one
  // turn accumulate correctly without re-reading the session row.
  let sequence = await loadMaxSequence(sessionId)
  let currentPhase: string | null = session.phase
  let titleResolved = session.title !== null
  let phaseHistory = [...session.phaseHistory]
  // Track the pipeline in closure scope so multiple <pipeline> emits in the
  // same turn union against the latest merged version, not the snapshot we
  // loaded from the DB at request start.
  let currentPipelinePhases: string[] | null = session.pipelinePhases
  let totalInputTokens = session.totalInputTokens
  let totalOutputTokens = session.totalOutputTokens

  // Persist the user's prompt as sequence N+1 so the chat history is
  // complete on rehydrate.
  sequence += 1
  persistMessage(sessionId, sequence, 'user', buildUserFrame(userMessage))
  // Fire-and-forget preview update; errors are swallowed the same way as
  // message persistence so they never break the live stream.
  Promise.resolve(
    sessionStore.updateLastMessagePreview(sessionId, parsed.data.message)
  ).catch((err) => {
    log.warn('failed to update last message preview', { err: String(err), sessionId })
  })

  const markerExtractor = new MarkerExtractor()
  const askExtractor = new AskExtractor()
  const fileDetector = new FileActivityDetector()

  let upstream: Response | null
  try {
    upstream = await fetch(`${webuiUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...client.proxyHeaders() },
      body: JSON.stringify({
        message: userMessage,
        requestId: parsed.data.requestId,
        sessionId: parsed.data.sessionId,
        workingDirectory: '/root/workspace',
      }),
      signal: req.signal,
    })
  } catch {
    upstream = null
  }

  if (!upstream || !upstream.ok || !upstream.body) {
    sessionStore.markStreaming(sessionId, false)
    return new Response(
      JSON.stringify({
        error: 'sandbox-unreachable',
        detail: 'webui upstream failed',
        retryable: true,
      }),
      { status: 502, headers: { 'content-type': 'application/json' } }
    )
  }

  const interceptor = createNDJSONInterceptor({
    onMessage: (msg) => {
      // Whole-body try/catch: a malformed regex match, an unexpected SDK
      // payload shape, or a thrown DB error from a synchronous code path
      // must NOT propagate out of this hook. If it did, the NDJSON
      // TransformStream would transition to `errored` and the downstream
      // lifecycle tail's `flush` / `cancel` hooks would never run, leaving
      // `streaming=true` permanently stuck on this session.
      //
      // On failure we log at warn (ops can spot the drift) and pass the
      // original frame through unchanged so the UI still gets the assistant
      // text — degraded extraction beats a hung session.
      try {
        const kind = classifyKind(msg)

        sequence += 1
        persistMessage(sessionId, sequence, kind, msg)

        // 1. Marker / ask extraction on assistant_text frames. Markers are
        //    stripped from the text sent downstream (users never see
        //    <phase> / <pipeline> / <title>); ask tags are NOT stripped —
        //    the frontend runs its own AskExtractor to render an inline
        //    card inside the chat bubble (it needs the original payload).
        //    pending_actions persistence still happens here so the
        //    notification center + cross-page rehydration can find the
        //    pending ask without re-parsing chat history.
        let outMsg = msg
        if (kind === 'assistant_text' || kind === 'tool_use') {
          const text = extractAssistantText(msg)
          if (text !== null) {
            const { cleaned: cleanedFromMarkers, markers } = markerExtractor.consume(text)
            const { asks } = askExtractor.consume(cleanedFromMarkers)
            outMsg = withCleanedText(msg, cleanedFromMarkers)

            if (kind === 'assistant_text') {
              // Update preview with cleaned text (markers stripped) so the
              // session dropdown shows meaningful content, not XML tags.
              Promise.resolve(
                sessionStore.updateLastMessagePreview(sessionId, cleanedFromMarkers)
              ).catch((err) => {
                log.warn('failed to update last message preview (assistant)', {
                  err: String(err),
                  sessionId,
                })
              })
            }

            for (const marker of markers) {
              if (marker.type === 'pipeline') {
                // Union semantics: phase names that disappear from a later
                // emit (e.g. AI drops "requirement" after brainstorming
                // completes) are preserved so the operator's timeline never
                // loses a step they already walked through. See
                // pipeline-union.ts.
                const merged = mergePipelineUnion(currentPipelinePhases ?? [], marker.phases)
                const phases = ensureAdoptionLast(merged)
                currentPipelinePhases = phases
                applySessionPatch(sessionId, { pipelinePhases: phases })
              } else if (marker.type === 'phase') {
                currentPhase = marker.name
                phaseHistory = [
                  ...phaseHistory,
                  { phase: marker.name, enteredAt: new Date().toISOString() },
                ]
                applySessionPatch(sessionId, { phase: currentPhase, phaseHistory })
              } else if (marker.type === 'title') {
                if (!titleResolved) {
                  titleResolved = true
                  applySessionPatch(sessionId, { title: marker.value })
                }
              }
            }

            for (const ask of asks) {
              persistPendingAction(sessionId, ask.askId, ask.type, ask)
            }
          }
        }

        // 2. Heuristic phase fallback — only while the AI hasn't taken
        //    over with an explicit <phase> marker. A previous revision
        //    ran the detector on every frame to catch AI text like
        //    "entering selfTest" without a marker, but the keyword/tool
        //    heuristics here are too coarse to override AI-declared phases
        //    — they routinely flipped coding → testing → done → verification
        //    in the middle of one turn, mangling phaseHistory. AI persona now
        //    pushes explicit <phase> on every transition; if it skips,
        //    the timeline simply lags rather than mis-advances.
        if (!currentPhase) {
          const detected = detectPhase(msg, currentPhase)
          if (detected) {
            currentPhase = detected
            phaseHistory = [
              ...phaseHistory,
              { phase: detected, enteredAt: new Date().toISOString() },
            ]
            applySessionPatch(sessionId, { phase: detected, phaseHistory })
          }
        }

        // 3. File activity → log for now; SSE channel is stubbed in B and the
        //    UI tails manifest/readme via SWR.
        const activity = fileDetector.consume(msg)
        if (activity) {
          log.debug('dev-studio file activity detected', { sessionId, activity })
        }

        // 4. Token accounting + lastActiveAt bump on result frames.
        if (kind === 'result') {
          const usage = (msg as { usage?: { input_tokens?: number; output_tokens?: number } }).usage
          const inputTokens = typeof usage?.input_tokens === 'number' ? usage.input_tokens : 0
          const outputTokens = typeof usage?.output_tokens === 'number' ? usage.output_tokens : 0
          totalInputTokens += inputTokens
          totalOutputTokens += outputTokens
          applySessionPatch(sessionId, {
            totalInputTokens,
            totalOutputTokens,
            lastActiveAt: new Date(),
          })
        }

        return outMsg
      } catch (err) {
        log.warn('extractor failure, passing raw message through', {
          err: String(err),
          sessionId,
        })
        return msg
      }
    },
  })

  const body = upstream.body
    .pipeThrough(interceptor)
    .pipeThrough(createStreamingLifecycleTail(sessionId))

  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'application/x-ndjson',
      'cache-control': 'no-cache',
    },
  })
}
