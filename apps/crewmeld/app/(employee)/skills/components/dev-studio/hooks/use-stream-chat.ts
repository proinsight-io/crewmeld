'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { mutate as globalMutate } from 'swr'
import { type Ask, AskExtractor } from '@/lib/dev-studio/ask-extractor'
import { getDevStudioPersona } from '@/lib/dev-studio/persona-extensions'
import { MarkerExtractor } from '@/lib/dev-studio/phase-marker-extractor'
import { useTranslation } from '@/hooks/use-translation'

// Local types — minimal mirror of @anthropic-ai/claude-code SDK message shapes.
// The SDK nests message content under a `message` envelope (matching the
// Anthropic API), NOT at the top level — earlier versions of this file
// accessed msg.content and silently dropped every assistant payload.
type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: unknown; is_error?: boolean }
  | { type: 'thinking'; thinking?: string }
  | { type: string; [key: string]: unknown }

interface AssistantMessage {
  type: 'assistant'
  session_id?: string
  message: {
    role: 'assistant'
    content: ContentBlock[]
    model?: string
    stop_reason?: string | null
    usage?: { input_tokens?: number; output_tokens?: number }
  }
  parent_tool_use_id?: string | null
  uuid?: string
}

interface UserMessage {
  type: 'user'
  session_id?: string
  message: {
    role: 'user'
    content: ContentBlock[]
  }
  parent_tool_use_id?: string | null
  tool_use_result?: unknown
  uuid?: string
}

interface SystemMessage {
  type: 'system'
  subtype: 'init' | 'hook_started' | 'hook_response' | string
  session_id?: string
  model?: string
  [key: string]: unknown
}

interface ResultMessage {
  type: 'result'
  subtype: 'success' | 'error_during_execution' | string
  session_id?: string
  is_error?: boolean
  result?: string
  duration_ms?: number
  usage?: { input_tokens?: number; output_tokens?: number }
  [key: string]: unknown
}

type SDKMessage = AssistantMessage | UserMessage | SystemMessage | ResultMessage

type StreamResponse =
  | { type: 'claude_json'; data: SDKMessage }
  | { type: 'error'; error: string }
  | { type: 'done' }
  | { type: 'aborted' }

export interface ToolResultItem {
  name?: string
  content: unknown
  isError: boolean
}

export type ChatMessage =
  | { id: string; kind: 'user'; text: string }
  | { id: string; kind: 'assistant_text'; text: string; streaming: boolean }
  | { id: string; kind: 'skill_loaded'; skill: string }
  | { id: string; kind: 'tool_use'; name: string; input: unknown }
  | { id: string; kind: 'tool_results'; items: ToolResultItem[] }
  | { id: string; kind: 'ask'; askId: string; ask: Ask }
  | { id: string; kind: 'system'; model?: string }
  | { id: string; kind: 'error'; text: string }
  | { id: string; kind: 'aborted' }
  | {
      id: string
      kind: 'result'
      durationMs?: number
      inputTokens?: number
      outputTokens?: number
    }

/** Tool names whose tool_result content is hidden from the user. */
const HIDDEN_TOOL_NAMES = new Set(['Skill'])

interface DbMessageRecord {
  id: string
  kind: string
  payload: Record<string, unknown>
  sequence: number
}

/**
 * Extract content blocks from a persisted SDK message payload.
 * Handles both envelope format (`msg.message.content`) and flat format
 * (`msg.content`) since user frames are stored flat while assistant
 * frames use the envelope.
 */
function getPayloadContent(payload: Record<string, unknown>): ContentBlock[] {
  const env = payload.message as { content?: unknown } | undefined
  if (env && Array.isArray(env.content)) return env.content as ContentBlock[]
  if (Array.isArray(payload.content)) return payload.content as ContentBlock[]
  return []
}

/** Strip protocol markers and ask/answer tags from historical assistant text. */
function stripProtocolTags(text: string): string {
  return (
    text
      .replace(/<pipeline>[\s\S]*?<\/pipeline>/g, '')
      .replace(/<phase>[\s\S]*?<\/phase>/g, '')
      .replace(/<title>[\s\S]*?<\/title>/g, '')
      .replace(/<ask[\s\S]*?<\/ask>/g, '')
      // `<answer ...>` is server→AI scaffolding the model sometimes echoes; it
      // must never render. Mirrors the streaming-path strip in MarkerExtractor.
      .replace(/<answer\b[^>]*>[\s\S]*?<\/answer>/g, '')
      .trim()
  )
}

/**
 * Extract the real user input from a persisted user message.
 * The first message has persona instructions prepended; resume messages
 * are "请继续" sentinels that should be hidden entirely.
 */
function extractUserText(raw: string): string | null {
  if (!raw || raw === '请继续') return null
  // Skill invocations inject the full skill body as a synthetic user turn
  // (claude-code-webui slash-command / Skill expansion). It is not operator
  // input, so it must never render as a user bubble. The live stream already
  // ignores user-role text blocks; this keeps restored history consistent.
  // Mirrors the assistant_text guard in dbRecordToChatMessages.
  if (raw.includes('Base directory for this skill:')) return null
  // Answer-resume / upload envelopes: the BFF prepends a `[系统提示] …` block
  // (with raw <answer> tags and the like) ahead of the real user message,
  // separated by a blank line (chat route composes `[...segments, '', msg]`).
  // Showing that block verbatim leaks protocol internals into the chat and
  // reads as a jarring blue bubble next to the clean ask cards. Strip the
  // block and keep only the trailing real message — hidden entirely when it
  // is the `请继续` resume sentinel (or empty).
  if (raw.startsWith('[系统提示]')) {
    const lastSplit = raw.lastIndexOf('\n\n')
    const userPart = lastSplit >= 0 ? raw.slice(lastSplit + 2).trim() : ''
    if (!userPart || userPart === '请继续') return null
    return userPart
  }
  // Persona-prefixed messages start with the AI engineer identity line.
  // The actual user input follows the LAST double-newline in the message.
  if (raw.startsWith('你是 AI工程师')) {
    const lastSplit = raw.lastIndexOf('\n\n')
    if (lastSplit >= 0) {
      let userPart = raw.slice(lastSplit + 2).trim()
      if (userPart.startsWith('/brainstorming ')) {
        userPart = userPart.slice('/brainstorming '.length).trim()
      }
      return userPart || null
    }
    return null
  }
  return raw
}

/**
 * Convert a DB message record into one or more ChatMessages for display.
 */
function dbRecordToChatMessages(
  rec: DbMessageRecord,
  toolRegistry: Map<string, { name: string; input: unknown }>
): ChatMessage[] {
  const id = rec.id
  const content = getPayloadContent(rec.payload)

  switch (rec.kind) {
    case 'user': {
      const textBlock = content.find((b) => b.type === 'text') as { text?: string } | undefined
      const raw = textBlock?.text ?? ''
      const text = extractUserText(raw)
      if (!text) return []
      return [{ id, kind: 'user', text }]
    }
    case 'assistant_text': {
      const textBlock = content.find((b) => b.type === 'text') as { text?: string } | undefined
      const raw = textBlock?.text ?? ''
      // Skip raw skill content dumps injected by claude-code-webui
      if (raw.includes('Base directory for this skill:')) return []
      const text = stripProtocolTags(raw)
      if (!text) return []
      return [{ id, kind: 'assistant_text', text, streaming: false }]
    }
    case 'tool_use': {
      const msgs: ChatMessage[] = []
      for (const block of content) {
        if (block.type !== 'tool_use') continue
        const b = block as { id: string; name: string; input: unknown }
        toolRegistry.set(b.id, { name: b.name, input: b.input })
        if (b.name === 'Skill') {
          const skill = (b.input as { skill?: string })?.skill ?? '(unknown)'
          msgs.push({ id: `${id}-${b.id}`, kind: 'skill_loaded', skill })
        } else {
          msgs.push({ id: `${id}-${b.id}`, kind: 'tool_use', name: b.name, input: b.input })
        }
      }
      return msgs
    }
    case 'tool_result':
      // Tool results are verbose internal data (file contents, skill payloads,
      // etc.). Skip them entirely in history — the tool_use card and assistant
      // text already convey what happened.
      return []
    case 'system': {
      const p = rec.payload
      if (p.subtype !== 'init') return []
      const model = p.model as string | undefined
      // Ready banner is translated at render time (dev-studio-message.tsx);
      // carry the raw model id, not a pre-rendered string.
      return [{ id, kind: 'system', model }]
    }
    case 'result': {
      const p = rec.payload
      if (p.is_error || p.subtype === 'error_during_execution') {
        return [
          {
            id,
            kind: 'error',
            text: (p.result as string) ?? `执行失败（${p.subtype ?? 'unknown'}）`,
          },
        ]
      }
      const usage = p.usage as { input_tokens?: number; output_tokens?: number } | undefined
      return [
        {
          id,
          kind: 'result',
          durationMs: p.duration_ms as number | undefined,
          inputTokens: usage?.input_tokens,
          outputTokens: usage?.output_tokens,
        },
      ]
    }
    default:
      return []
  }
}

export interface UseStreamChatResult {
  messages: ChatMessage[]
  busy: boolean
  /**
   * True while the persisted history for the current session is being fetched
   * (on first landing and on every session switch). Drives the chat panel's
   * loading spinner so a session switch never shows a blank panel mid-load.
   */
  loadingHistory: boolean
  isFirstMessage: boolean
  /**
   * Send a chat turn. `opts.hidden` suppresses the user bubble (used for
   * resume sentinels and mid-session connection nudges) — the message is still
   * forwarded to the model and persisted.
   */
  send: (text: string, opts?: { hidden?: boolean }) => Promise<void>
  abort: () => Promise<void>
  /**
   * Continue the conversation after an inline ask was answered. Posts a
   * sentinel user message (a single space, hidden from the chat list) so
   * the BFF flushes its queued system notes (the persisted ask answer) and
   * the AI's next turn arrives without the operator having to type
   * anything manually.
   */
  resumeAfterAsk: () => Promise<void>
  /** Latest pipeline phases from a `<pipeline>` marker, or `null` if none seen. */
  pipelinePhases: string[] | null
  /** Latest `<phase>` marker name, or `null` if none seen. */
  currentPhase: string | null
  /** Latest `<title>` marker value, or `null` if none seen. */
  title: string | null
}

const SESSIONS_SWR_KEY_PREFIX = '/api/employee/dev-studio/sessions'

/**
 * UUID v4 with a Math.random fallback. `crypto.randomUUID` is only exposed
 * in secure contexts (HTTPS or localhost); production deployments served
 * over plain HTTP threw "crypto.randomUUID is not a function" on Send.
 */
function newUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

/**
 * @param sessionId - Active dev-studio session, or null when none selected.
 * @param initialConnectionContext - Pre-composed, single-paragraph note about
 *   the system connection the operator bound *before* sending the first
 *   message (connection name/type + `CONN_*` variable names). Woven into the
 *   first turn only, right after the persona, so the model builds the tool
 *   against those env vars. `null` when no connection is bound up front
 *   (mid-session selections are handled by the dialog via a hidden `send`).
 */
export function useStreamChat(
  sessionId: string | null,
  initialConnectionContext: string | null = null
): UseStreamChatResult {
  const { locale } = useTranslation()
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [busy, setBusy] = useState(false)
  const [loadingHistory, setLoadingHistory] = useState(false)
  const [isFirstMessage, setIsFirstMessage] = useState(true)
  const [pipelinePhases, setPipelinePhases] = useState<string[] | null>(null)
  const [currentPhase, setCurrentPhase] = useState<string | null>(null)
  const [title, setTitle] = useState<string | null>(null)
  const requestIdRef = useRef<string | null>(null)
  const claudeSessionIdRef = useRef<string | undefined>(undefined)
  const toolUseRegistryRef = useRef(new Map<string, { name: string; input: unknown }>())
  // Tracks the active sessionId so stream handlers from a previous session
  // can detect they're stale and skip state mutations. Without this, error
  // frames from a destroyed container leak into the new session's chat.
  const activeSessionIdRef = useRef<string | null>(sessionId)
  activeSessionIdRef.current = sessionId
  // Per-request marker extractor; instantiated at the start of each `send()` so
  // its internal buffer never bleeds across requests.
  const markerExtractorRef = useRef<MarkerExtractor | null>(null)
  // Per-request ask extractor — same lifecycle as the marker one. The BFF
  // intentionally does NOT strip <ask> tags any more (it only writes them to
  // pending_actions for the notification center); we run our own extractor
  // so we can both strip the raw tag from the bubble and inject an inline
  // 'ask' chat message right where the AI emitted it.
  const askExtractorRef = useRef<AskExtractor | null>(null)
  // Mirror of `busy` for synchronous read inside callbacks (useState value is
  // captured at closure time, but we want resumeAfterAsk to see the latest).
  const busyRef = useRef(false)
  useEffect(() => {
    busyRef.current = busy
  }, [busy])
  // Dedup guard for resumeAfterAsk. AskInlineCard can end up firing it twice
  // when the operator answers inline (postAnswer triggers it once, then the
  // SWR-mutated notifications cache flips externallyAnswered → true and
  // fires it again). Without this, two send() calls race on the shared
  // extractor refs and chunks from the first stream get mis-parsed.
  const resumePendingRef = useRef(false)

  // When the session changes, reset chat state and load persisted history from
  // the DB so switching between sessions restores the conversation.
  useEffect(() => {
    setMessages([])
    setBusy(false)
    setIsFirstMessage(true)
    setPipelinePhases(null)
    setCurrentPhase(null)
    setTitle(null)
    requestIdRef.current = null
    claudeSessionIdRef.current = undefined
    toolUseRegistryRef.current.clear()
    markerExtractorRef.current = null
    askExtractorRef.current = null

    if (!sessionId) {
      setLoadingHistory(false)
      return
    }
    let cancelled = false
    setLoadingHistory(true)
    const base = `/api/employee/dev-studio/sessions/${encodeURIComponent(sessionId)}`
    void (async () => {
      try {
        // Load persisted history AND still-pending asks together. Both feed the
        // restored list; either fetch failing (or returning undefined under
        // test) is tolerated via optional chaining.
        const [msgRes, askRes] = await Promise.all([
          fetch(`${base}/messages`),
          fetch(`${base}/pending-asks`),
        ])
        if (cancelled) return
        const registry = new Map<string, { name: string; input: unknown }>()
        const restored: ChatMessage[] = []
        // Latest claude session id carried by the persisted frames. Assistant /
        // system / result frames store the SDK message verbatim, which includes
        // `session_id` at the top level; it is stable across a conversation.
        let latestClaudeSessionId: string | undefined
        if (msgRes?.ok) {
          const data = (await msgRes.json()) as { messages?: DbMessageRecord[] }
          for (const rec of data.messages ?? []) {
            const sid = (rec.payload as { session_id?: unknown })?.session_id
            if (typeof sid === 'string' && sid) latestClaudeSessionId = sid
            restored.push(...dbRecordToChatMessages(rec, registry))
          }
        }
        // Re-surface unanswered HITL asks as inline cards. Streamed <ask> tags
        // are stripped from persisted assistant text and the SDK does not
        // re-emit them on resume, so a question the operator backgrounded would
        // otherwise be invisible (and unanswerable) in the workbench. Appended
        // last so the newest pending ask is the unlocked/answerable one.
        if (askRes?.ok) {
          const { asks } = (await askRes.json()) as { asks: Ask[] }
          for (const ask of asks ?? []) {
            if (ask?.askId) {
              restored.push({ id: `pending-ask-${ask.askId}`, kind: 'ask', askId: ask.askId, ask })
            }
          }
        }
        if (cancelled) return
        toolUseRegistryRef.current = registry
        // Restore the claude session id so the NEXT turn resumes the prior
        // conversation instead of starting a fresh one. Without this the model
        // forgets everything shown in the restored history: the chat route only
        // resumes when the request carries this id, and it was reset to
        // undefined at the top of this effect on every session switch / reopen.
        // Guard on the ref still being empty so a turn that started mid-load
        // (its live `session_id` already captured) is not clobbered with the
        // older persisted id.
        if (latestClaudeSessionId && !claudeSessionIdRef.current) {
          claudeSessionIdRef.current = latestClaudeSessionId
        }
        if (restored.length > 0) {
          // Defensive merge: if a turn was already started while history was
          // loading (input is normally disabled until then, but programmatic
          // sends can still fire), prepend the restored history instead of
          // replacing — otherwise `setMessages(restored)` would wipe the live
          // user message + streaming reply.
          setMessages((prev) => (prev.length === 0 ? restored : [...restored, ...prev]))
          setIsFirstMessage(false)
        }
      } catch {
        // An empty chat is an acceptable fallback if the load fails.
      } finally {
        // Clear the spinner only when this effect run is still current; a
        // superseded run (session switched mid-load) must not flip the flag
        // for the newer load that already set it true.
        if (!cancelled) setLoadingHistory(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [sessionId])

  function newId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  }

  function appendAssistantText(delta: string) {
    setMessages((prev) => {
      const last = prev[prev.length - 1]
      if (last && last.kind === 'assistant_text' && last.streaming) {
        // Append to an in-flight bubble even when delta is whitespace —
        // those line breaks/spaces are meaningful for separating segments.
        const updated: ChatMessage = { ...last, text: last.text + delta }
        return [...prev.slice(0, -1), updated]
      }
      // Don't open a fresh bubble for whitespace-only delta. Markers
      // (<phase>/<pipeline>/<title>/<ask>) get stripped to empty/whitespace
      // when they are the only payload in a text block; without this
      // guard the residual "\n" produced an empty grey bubble that never
      // got filled because the next frame was a tool_use that closed it.
      if (!delta.trim()) return prev
      return [...prev, { id: newId(), kind: 'assistant_text', text: delta, streaming: true }]
    })
  }

  function finalizeStreamingMessage() {
    setMessages((prev) => {
      const last = prev[prev.length - 1]
      if (last && last.kind === 'assistant_text' && last.streaming) {
        return [...prev.slice(0, -1), { ...last, streaming: false }]
      }
      return prev
    })
  }

  function handleSDKMessage(msg: SDKMessage) {
    if (msg.session_id) claudeSessionIdRef.current = msg.session_id

    // Debug: enable via `localStorage.devStudioDebug = '1'` in the browser console.
    // Logs every SDKMessage so we can diagnose missing content / unexpected blocks.
    if (typeof window !== 'undefined' && window.localStorage?.getItem('devStudioDebug') === '1') {
      // biome-ignore lint/suspicious/noConsole: opt-in debug
      console.log('[dev-studio] SDKMessage', msg)
    }

    if (msg.type === 'system') {
      // Only surface the init banner; hook lifecycle events are noise.
      if (msg.subtype !== 'init') return
      const modelInfo = msg.model
      setMessages((prev) => [
        ...prev,
        {
          id: newId(),
          kind: 'system',
          model: modelInfo,
        },
      ])
      return
    }

    if (msg.type === 'result') {
      // Surface execution errors so the user knows why nothing rendered.
      // result.result also carries the full consolidated assistant answer on
      // success, but the streamed assistant messages already rendered it, so
      // we deliberately do NOT re-render that to avoid duplication.
      if (msg.is_error || msg.subtype === 'error_during_execution') {
        setMessages((prev) => [
          ...prev,
          {
            id: newId(),
            kind: 'error',
            text: msg.result ?? `执行失败（${msg.subtype ?? 'unknown'}）`,
          },
        ])
        return
      }
      finalizeStreamingMessage()
      setMessages((prev) => [
        ...prev,
        {
          id: newId(),
          kind: 'result',
          durationMs: msg.duration_ms,
          inputTokens: msg.usage?.input_tokens,
          outputTokens: msg.usage?.output_tokens,
        },
      ])
      return
    }

    // assistant / user — the actual content lives under msg.message.content[].
    // The discriminated union catch-all (forward-compat for unknown types)
    // breaks TS narrowing on `type`; we cast to the concrete shape per branch.
    const content = msg.message?.content
    if (!content) return

    for (const block of content) {
      if (msg.type === 'assistant') {
        if (block.type === 'text') {
          const b = block as { type: 'text'; text: string }
          // Two-stage extraction: markers first (always stripped — protocol
          // never reaches the user), then asks (also stripped from the
          // bubble, but each ask emits a dedicated 'ask' chat message so the
          // interactive card renders inline where the AI placed it).
          const markerEx = markerExtractorRef.current
          const askEx = askExtractorRef.current
          let cleaned = b.text
          if (markerEx) {
            const r = markerEx.consume(b.text)
            cleaned = r.cleaned
            for (const marker of r.markers) {
              if (marker.type === 'pipeline') setPipelinePhases(marker.phases)
              else if (marker.type === 'phase') setCurrentPhase(marker.name)
              else if (marker.type === 'title') {
                setTitle(marker.value)
                // Best-effort: refresh the cached session list so peer
                // components (e.g. the SessionSwitcher) pick up the
                // newly-assigned title without waiting for the 60s poll.
                void globalMutate(
                  (key) => typeof key === 'string' && key.startsWith(SESSIONS_SWR_KEY_PREFIX)
                )
              }
            }
          }
          if (askEx) {
            // Use the ordered `segments` output so each ask card lands in
            // the exact position the AI placed it — between the text that
            // came before and the text that came after. Falling back to the
            // flat `cleaned` string would dump all surrounding text on
            // *one* side of the ask cards, breaking the question/answer
            // visual order.
            const { segments } = askEx.consume(cleaned)
            for (const seg of segments) {
              if (seg.type === 'text') {
                if (seg.text) appendAssistantText(seg.text)
              } else {
                // Close out the in-flight streaming text so the next chunk
                // starts a fresh bubble below the ask card.
                finalizeStreamingMessage()
                setMessages((prev) => [
                  ...prev,
                  { id: newId(), kind: 'ask', askId: seg.ask.askId, ask: seg.ask },
                ])
              }
            }
          } else if (cleaned) {
            appendAssistantText(cleaned)
          }
        } else if (block.type === 'tool_use') {
          finalizeStreamingMessage()
          const b = block as { type: 'tool_use'; id: string; name: string; input: unknown }
          toolUseRegistryRef.current.set(b.id, { name: b.name, input: b.input })
          if (b.name === 'Skill') {
            const skill = (b.input as { skill?: string })?.skill ?? '(未知)'
            setMessages((prev) => [...prev, { id: newId(), kind: 'skill_loaded', skill }])
          } else {
            setMessages((prev) => [
              ...prev,
              { id: newId(), kind: 'tool_use', name: b.name, input: b.input },
            ])
          }
        }
        // thinking blocks intentionally not surfaced — internal reasoning
      } else if (msg.type === 'user') {
        if (block.type === 'tool_result') {
          const b = block as {
            type: 'tool_result'
            tool_use_id: string
            content: unknown
            is_error?: boolean
          }
          const info = toolUseRegistryRef.current.get(b.tool_use_id)
          if (info && HIDDEN_TOOL_NAMES.has(info.name)) continue // hide
          const item: ToolResultItem = {
            name: info?.name,
            content: b.content,
            isError: b.is_error ?? false,
          }
          // Merge into the last tool_results group if consecutive — keeps the
          // chat compact when claude does many tool calls in a single turn.
          setMessages((prev) => {
            const last = prev[prev.length - 1]
            if (last && last.kind === 'tool_results') {
              const updated: ChatMessage = { ...last, items: [...last.items, item] }
              return [...prev.slice(0, -1), updated]
            }
            return [...prev, { id: newId(), kind: 'tool_results', items: [item] }]
          })
        }
      }
    }
  }

  const send = useCallback(
    async (text: string, opts?: { hidden?: boolean }) => {
      if (!sessionId) return
      const hidden = opts?.hidden ?? false
      // Refuse concurrent sends in either mode — two sends in flight share
      // the markerExtractor / askExtractor refs and the second one's reset
      // wipes the first one's buffer, so chunks from the first stream get
      // mis-parsed. resumeAfterAsk handles the busy case by aborting first.
      if (busy) return

      let actualMessage = text
      // Brainstorming auto-injection + persona prepend are first-turn only
      // semantics — skip them for hidden resume sends, which just exist to
      // flush BFF-queued system notes (the persisted ask answer).
      const willInjectBrainstorming = !hidden && isFirstMessage && !text.trim().startsWith('/')
      if (willInjectBrainstorming) {
        actualMessage = `/brainstorming ${text.trim()}`
      }
      // On the very first message of a session, prepend the full persona
      // prompt (A identity + working-dir contract + B output protocol) so the
      // model knows what to build and what to avoid. The instructions stay in
      // claude's session context for subsequent turns.
      //
      // The B-phase output protocol declares the `<title>` / `<pipeline>` /
      // `<phase>` / `<ask>` markers + manifest.json + README.md outputs.
      // Without it the AI falls back to the built-in AskUserQuestion tool
      // (which rejects 5+ options) and never emits the markers the header /
      // right panel listen for — so the pipeline timeline stays frozen, the
      // right panel never auto-opens when a manifest lands, and tool name /
      // README never surface. The prompt body itself is locale-routed via
      // getDevStudioPersona so en-locale operators get an English prompt
      // and English replies.
      if (isFirstMessage && !hidden) {
        const persona = getDevStudioPersona(locale)
        // Weave the bound connection's context (if any) between the persona and
        // the real user message. It is a single paragraph (no blank lines) so
        // the persona-prefix parser in extractUserText still splits on the
        // final \n\n and recovers the operator's original message verbatim.
        const connCtx = initialConnectionContext ? `${initialConnectionContext}\n\n` : ''
        actualMessage = `${persona}\n\n${connCtx}${actualMessage}`
      }

      const requestId = newUuid()
      requestIdRef.current = requestId
      // Fresh extractor per request so a partial marker from a previous send
      // can never leak into the new one's buffer.
      markerExtractorRef.current = new MarkerExtractor()
      askExtractorRef.current = new AskExtractor()
      setBusy(true)
      if (!hidden) {
        setMessages((prev) => [...prev, { id: newId(), kind: 'user', text }])
      }

      let res: Response
      try {
        res = await fetch(
          `/api/employee/dev-studio/sessions/${encodeURIComponent(sessionId)}/chat`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              message: actualMessage,
              requestId,
              sessionId: claudeSessionIdRef.current,
            }),
          }
        )
      } catch (e) {
        setMessages((prev) => [
          ...prev,
          { id: newId(), kind: 'error', text: `网络错误：${String(e)}` },
        ])
        setBusy(false)
        requestIdRef.current = null
        return
      }

      if (!res.ok || !res.body) {
        const text =
          res.status === 404
            ? '会话已失效（服务端可能重启过），请关闭对话框重新打开。'
            : `请求失败（${res.status}）`
        setMessages((prev) => [...prev, { id: newId(), kind: 'error', text }])
        setBusy(false)
        requestIdRef.current = null
        return
      }

      if (willInjectBrainstorming || text.trim().startsWith('/')) {
        setIsFirstMessage(false)
      }

      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
      const streamSessionId = sessionId
      let buf = ''
      try {
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          // Session changed while this stream was open (e.g. user clicked
          // "+ new session" which destroyed the old container). Drop all
          // remaining frames so error/abort artifacts don't leak into the
          // new session's chat.
          if (activeSessionIdRef.current !== streamSessionId) break
          buf += value
          const lines = buf.split('\n')
          buf = lines.pop() ?? ''
          for (const line of lines) {
            if (!line) continue
            let evt: StreamResponse
            try {
              evt = JSON.parse(line)
            } catch {
              continue
            }
            if (activeSessionIdRef.current !== streamSessionId) break
            if (evt.type === 'claude_json') handleSDKMessage(evt.data)
            else if (evt.type === 'error')
              setMessages((prev) => [...prev, { id: newId(), kind: 'error', text: evt.error }])
            else if (evt.type === 'aborted')
              setMessages((prev) => [...prev, { id: newId(), kind: 'aborted' }])
          }
        }
      } finally {
        if (activeSessionIdRef.current === streamSessionId) {
          finalizeStreamingMessage()
          setBusy(false)
        }
        requestIdRef.current = null
      }
    },
    [sessionId, busy, isFirstMessage, initialConnectionContext, locale]
  )

  const abort = useCallback(async () => {
    if (!sessionId || !requestIdRef.current) return
    await fetch(`/api/employee/dev-studio/sessions/${encodeURIComponent(sessionId)}/abort`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: requestIdRef.current }),
    }).catch(() => {})
  }, [sessionId])

  /**
   * Continue the conversation after an ask was answered. The send needs to
   * drain the BFF system-note queue (the persisted `<answer>` tag) into the
   * AI's next turn. Two complications drove this implementation:
   *
   *  1. Dedup. AskInlineCard can fire onAnswered twice — once from its own
   *     postAnswer, then again when the SWR-mutated notifications cache
   *     flips externallyAnswered → true. resumePendingRef collapses both
   *     into a single resume so the AI doesn't see two "请继续" sentinels.
   *  2. Concurrency. The previous turn's stream may still be open when the
   *     ask arrived (SDK kept the reader alive). We don't allow parallel
   *     sends (they corrupt the shared extractor buffers), so abort the
   *     in-flight stream first and wait for busy to clear before sending.
   *
   * The "请继续" sentinel pairs with the BFF's `[系统提示] ...<answer>...`
   * envelope so the AI reads "user answered X, keep going" rather than a
   * naked space (the Claude SDK rejects blank messages with exit code 1).
   */
  const resumeAfterAsk = useCallback(async () => {
    if (resumePendingRef.current) return
    resumePendingRef.current = true
    try {
      if (busyRef.current) {
        await abort()
        // Wait for the abort to actually flush busy → false so the send
        // below doesn't short-circuit. Cap the wait so a stuck stream
        // can't deadlock the resume forever.
        const deadline = Date.now() + 5_000
        while (busyRef.current && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 30))
        }
      }
      await send('请继续', { hidden: true })
    } finally {
      // Reopen the gate after a beat so the same session can resume again
      // if the AI emits another <ask>.
      setTimeout(() => {
        resumePendingRef.current = false
      }, 250)
    }
  }, [abort, send])

  return {
    messages,
    busy,
    loadingHistory,
    isFirstMessage,
    send,
    abort,
    resumeAfterAsk,
    pipelinePhases,
    currentPhase,
    title,
  }
}
