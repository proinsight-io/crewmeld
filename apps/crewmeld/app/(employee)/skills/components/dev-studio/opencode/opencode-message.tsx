'use client'

import type React from 'react'
import { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { OpencodeMarkdown } from './render/markdown'
import { ToolPartDisplay } from './render/tools/registry'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single opencode message part (text, tool call, reasoning, etc.). */
interface OpencodePart {
  id: string
  type: string
  text?: string
  tool?: string
  /** Raw state blob from the SSE stream — narrowed via {@link asToolPartState}. */
  state?: unknown
  /** Synthetic parts (e.g. injected skill body text) must not be rendered. */
  synthetic?: boolean
  /** Parts marked ignored must not be rendered. */
  ignored?: boolean
  [k: string]: unknown
}

/** A full opencode UI message with aggregated parts. */
export interface OpencodeUiMessage {
  id: string
  role: 'user' | 'assistant'
  aborted?: boolean
  parts: OpencodePart[]
}

// ---------------------------------------------------------------------------
// Marker stripping
// ---------------------------------------------------------------------------

/**
 * Remove claudecode-only marker tags from assistant text, preserving question
 * text inside `<ask>` blocks so questions remain visible to the user.
 *
 * Tags whose tag + content are stripped entirely: `<title>`, `<pipeline>`, `<phase>`.
 * `<ask>` is handled differently — only the wrapping tags are removed and the
 * inner text is preserved so AI-posed clarification questions are not silently lost.
 *
 * These are protocol tokens emitted by the claudecode persona that opencode may
 * reproduce verbatim if residual instructions reach it.
 */
export function stripOpencodeMarkers(text: string): string {
  // Strip title, pipeline, and phase tags along with their full content.
  let result = text.replace(/<(title|pipeline|phase)(?:\s[^>]*)?>[\s\S]*?<\/\1>/g, '')
  // Strip ask tag wrappers only — preserve inner text so questions reach the user.
  result = result.replace(
    /<ask(?:\s[^>]*)?>([\s\S]*?)<\/ask>/g,
    (_match: string, inner: string) => inner.trim(),
  )
  return result.trim()
}

// ---------------------------------------------------------------------------
// State narrowing helpers
// ---------------------------------------------------------------------------

/**
 * Concrete shape we care about from a tool part's `state` blob.
 * All fields are optional to handle partial / in-flight states gracefully.
 */
interface ToolPartState {
  status?: string
  input?: Record<string, unknown>
  output?: string
  error?: string
  metadata?: Record<string, unknown>
}

/**
 * Narrow an unknown `state` value to {@link ToolPartState}.
 * Returns an empty object if the value is not a plain object.
 */
function asToolPartState(state: unknown): ToolPartState {
  if (state === null || typeof state !== 'object' || Array.isArray(state)) return {}
  const s = state as Record<string, unknown>
  return {
    status: typeof s.status === 'string' ? s.status : undefined,
    output: typeof s.output === 'string' ? s.output : undefined,
    error: typeof s.error === 'string' ? s.error : undefined,
    input:
      s.input !== null && typeof s.input === 'object' && !Array.isArray(s.input)
        ? (s.input as Record<string, unknown>)
        : undefined,
    metadata:
      s.metadata !== null && typeof s.metadata === 'object' && !Array.isArray(s.metadata)
        ? (s.metadata as Record<string, unknown>)
        : undefined,
  }
}

// ---------------------------------------------------------------------------
// Context tool grouping
// ---------------------------------------------------------------------------

/** Tool names that represent context-retrieval operations. */
const CONTEXT_TOOLS = new Set(['read', 'glob', 'grep', 'list'])

/** Returns true if a part is a context-retrieval tool call. */
function isContextToolPart(part: OpencodePart): boolean {
  return part.type === 'tool' && part.tool !== undefined && CONTEXT_TOOLS.has(part.tool)
}

// ---------------------------------------------------------------------------
// Renderable filter
// ---------------------------------------------------------------------------

/**
 * Returns true when a part should be rendered in the assistant message body.
 *
 * Rules:
 * - `text`: visible, non-empty, non-synthetic, non-ignored text.
 * - `tool`: all tools except `todowrite` (handled by the todo panel).
 * - `reasoning` and all other part types: always hidden.
 */
function renderable(part: OpencodePart): boolean {
  switch (part.type) {
    case 'text':
      return Boolean(part.text?.trim()) && part.synthetic !== true && part.ignored !== true
    case 'tool':
      return part.tool !== 'todowrite'
    default:
      return false
  }
}

// ---------------------------------------------------------------------------
// ContextToolGroup
// ---------------------------------------------------------------------------

interface ContextToolGroupProps {
  /** Consecutive context-retrieval tool parts to group together. */
  parts: OpencodePart[]
}

/**
 * Collapsible card grouping consecutive context-retrieval tool calls
 * (read, glob, grep, list) under a single summary row.
 * Collapsed by default to reduce visual noise.
 */
function ContextToolGroup({ parts }: ContextToolGroupProps): React.JSX.Element {
  const [open, setOpen] = useState(false)

  return (
    <div data-testid='opencode-message:context-group' className='rounded border text-sm'>
      <button
        type='button'
        className='flex w-full cursor-pointer items-center gap-1.5 px-2 py-1.5 text-left text-muted-foreground'
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown className='h-3.5 w-3.5 shrink-0' />
        ) : (
          <ChevronRight className='h-3.5 w-3.5 shrink-0' />
        )}
        <span className='text-xs'>上下文检索 · {parts.length} 项</span>
      </button>

      {open && (
        <div className='space-y-1 border-t px-2 py-1.5'>
          {parts.map((p) => {
            const { status, input, output, metadata } = asToolPartState(p.state)
            return (
              <ToolPartDisplay
                key={p.id}
                tool={p.tool ?? ''}
                input={input ?? {}}
                metadata={metadata ?? {}}
                output={output}
                status={status}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// OpencodePartView
// ---------------------------------------------------------------------------

/**
 * Renders a single renderable assistant message part.
 * - Text parts → {@link OpencodeMarkdown}.
 * - Tool parts → {@link ToolPartDisplay} (registry handles all dispatch rules).
 */
function OpencodePartView({ part }: { part: OpencodePart }): React.JSX.Element | null {
  if (part.type === 'text') {
    return (
      <div className='text-sm'>
        <OpencodeMarkdown text={stripOpencodeMarkers(part.text ?? '')} />
      </div>
    )
  }

  if (part.type === 'tool') {
    const { status, input, output, metadata } = asToolPartState(part.state)
    return (
      <ToolPartDisplay
        tool={part.tool ?? ''}
        input={input ?? {}}
        metadata={metadata ?? {}}
        output={output}
        status={status}
      />
    )
  }

  return null
}

// ---------------------------------------------------------------------------
// Group building
// ---------------------------------------------------------------------------

/** Display group: a single part or a cluster of context tool parts. */
type PartGroup = { kind: 'single'; part: OpencodePart } | { kind: 'context'; parts: OpencodePart[] }

/**
 * Collapse a flat list of renderable parts into display groups.
 * Consecutive context tool parts are merged into a single {@link ContextToolGroup}.
 */
function buildGroups(parts: OpencodePart[]): PartGroup[] {
  const groups: PartGroup[] = []
  let contextBatch: OpencodePart[] = []

  const flushContext = () => {
    if (contextBatch.length === 0) return
    groups.push({ kind: 'context', parts: contextBatch })
    contextBatch = []
  }

  for (const p of parts) {
    if (isContextToolPart(p)) {
      contextBatch.push(p)
    } else {
      flushContext()
      groups.push({ kind: 'single', part: p })
    }
  }
  flushContext()
  return groups
}

// ---------------------------------------------------------------------------
// OpencodeMessage
// ---------------------------------------------------------------------------

/**
 * Renders a single opencode message.
 *
 * - User messages → right-aligned chat bubble.
 * - Assistant messages → left-aligned part sequence, with consecutive
 *   context-retrieval tools collapsed into a {@link ContextToolGroup}.
 */
export function OpencodeMessage({ message }: { message: OpencodeUiMessage }): React.JSX.Element {
  if (message.role === 'user') {
    const text = message.parts
      .filter((p) => p.type === 'text' && p.synthetic !== true && p.ignored !== true)
      .map((p) => p.text ?? '')
      .join('')
      .trim()
      // The first turn is routed through `/brainstorming <text>`; hide that
      // internal prefix from the operator's own bubble (mirrors the claude path).
      .replace(/^\/brainstorming\s+/, '')

    return (
      <div data-testid={`opencode-message:item:${message.id}`} className='flex justify-end'>
        {text && (
          <div className='ml-auto max-w-[85%] rounded-lg bg-primary/10 px-3 py-2 text-sm whitespace-pre-wrap'>
            {text}
          </div>
        )}
      </div>
    )
  }

  // Assistant: filter renderable parts, group context tools, then render
  const visible = message.parts.filter(renderable)
  const groups = buildGroups(visible)

  return (
    <div data-testid={`opencode-message:item:${message.id}`} className='space-y-1'>
      {groups.map((g, idx) =>
        g.kind === 'context' ? (
          // eslint-disable-next-line react/no-array-index-key
          <ContextToolGroup key={`ctx-${idx}`} parts={g.parts} />
        ) : (
          <OpencodePartView key={g.part.id} part={g.part} />
        )
      )}
      {message.aborted && (
        <div className='text-xs text-muted-foreground' data-testid='opencode-message:aborted'>
          已中止
        </div>
      )}
    </div>
  )
}
