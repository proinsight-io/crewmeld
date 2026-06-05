/**
 * Streaming extractor for structured `<ask>` prompts embedded in AI text.
 *
 * The B-phase protocol asks the AI to emit interactive questions as
 * `<ask id="..." type="...">{json}</ask>` tags rather than free-form prose.
 * Each tag carries a Zod-validated payload:
 * - `choice` — multi-option select (>=2 options required)
 * - `confirm` — yes/no confirmation
 * - `text` — free-form text answer with optional placeholder
 *
 * Tags that fail JSON parsing or Zod validation are logged at warn level
 * and the raw `<ask>` tag is preserved in the cleaned output (rather than
 * silently stripped) so users still see *something* on malformed payloads —
 * matching spec §6.10 and the pipeline marker's behaviour.
 *
 * Tag-spanning chunk boundaries are handled by buffering the trailing
 * partial open tag until the closing `</ask>` arrives in a later chunk.
 */

import { createLogger } from '@crewmeld/logger'
import { z } from 'zod'

const log = createLogger('dev-studio:ask-extractor')

export const AskPayload = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('choice'),
    question: z.string(),
    options: z.array(z.object({ value: z.string(), label: z.string() })).min(2),
  }),
  z.object({ type: z.literal('confirm'), question: z.string() }),
  z.object({ type: z.literal('text'), prompt: z.string(), placeholder: z.string().optional() }),
])

export type Ask = z.infer<typeof AskPayload> & { askId: string }

/**
 * A streaming consume result fragment. The UI replays these in order so an
 * `<ask>` card renders in the position the AI placed it, not after every
 * surrounding sentence (which is what happens when you only get a flat
 * `cleaned` string back).
 */
export type AskSegment = { type: 'text'; text: string } | { type: 'ask'; ask: Ask }

const ASK_RE = /<ask\s+id="([^"]+)"\s+type="([^"]+)"\s*>([\s\S]*?)<\/ask>/g

/**
 * Returns the offset where the trailing portion of `text` becomes a
 * potentially-unfinished `<ask ...>` tag that must be carried into the
 * next chunk. Returns `text.length` when no buffering is required.
 *
 * Walks **left-to-right** so an unclosed `<ask ...>` early in the buffer
 * wins over a later `<` (e.g. the `<` of `</ask>`). A right-to-left scan
 * would split inside the pending tag and leak the opening into cleaned.
 */
function findPendingAskSplit(text: string): number {
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '<') continue
    const tail = text.substring(i)
    if ('<ask'.startsWith(tail)) return i
    if (tail.startsWith('<ask') && !tail.includes('</ask>')) return i
  }
  return text.length
}

export class AskExtractor {
  private buffer = ''

  /**
   * Feed a streamed text chunk and receive any newly-completed asks plus
   * the cleaned text with successfully-parsed `<ask>` tags removed AND an
   * ordered list of segments that interleave surrounding text with each
   * parsed ask in the position the AI emitted it.
   *
   * Three outputs from one parse so callers can pick the right shape:
   *  - `cleaned`  — flat string for legacy consumers (BFF persistence flow).
   *  - `asks`     — flat list of parsed payloads (for pending_actions insert).
   *  - `segments` — order-preserving slice list (for the UI bubble flow so
   *                 each ask card lands between the text that surrounded it).
   *
   * Malformed asks (bad JSON, missing fields, Zod rejection) are logged at
   * warn level and their raw tag is *retained* in both `cleaned` AND as a
   * text-typed segment — see class-level docstring for rationale.
   */
  consume(text: string): { cleaned: string; asks: Ask[]; segments: AskSegment[] } {
    const combined = this.buffer + text
    const asks: Ask[] = []
    const segments: AskSegment[] = []
    const cleanedPieces: string[] = []
    const pushText = (s: string) => {
      if (!s) return
      cleanedPieces.push(s)
      const last = segments[segments.length - 1]
      if (last && last.type === 'text') {
        last.text += s
      } else {
        segments.push({ type: 'text', text: s })
      }
    }

    // exec loop with a stateful regex so we can read .lastIndex for slicing.
    const re = new RegExp(ASK_RE.source, 'g')
    let cursor = 0
    let m: RegExpExecArray | null = re.exec(combined)
    while (m !== null) {
      pushText(combined.slice(cursor, m.index))
      const [match, askId, type, body] = m
      const ask = tryParseAsk(askId, type, body)
      if (ask) {
        asks.push(ask)
        segments.push({ type: 'ask', ask })
      } else {
        // Keep the raw tag visible (matches the old behaviour).
        pushText(match)
      }
      cursor = m.index + match.length
      m = re.exec(combined)
    }

    // Anything left after the last completed match is the tail. If the tail
    // contains a partially-streamed `<ask` opener we buffer it until the
    // closing tag arrives in a subsequent chunk.
    const tail = combined.slice(cursor)
    const splitAt = findPendingAskSplit(tail)
    if (splitAt < tail.length) {
      pushText(tail.slice(0, splitAt))
      this.buffer = tail.slice(splitAt)
    } else {
      pushText(tail)
      this.buffer = ''
    }

    return { cleaned: cleanedPieces.join(''), asks, segments }
  }
}

/**
 * Validate one `<ask>` body. Returns the typed `Ask` on success, `null` on
 * any JSON / Zod failure (with a warn log). Hoisted out of `consume` so the
 * loop body stays linear.
 */
function tryParseAsk(askId: string, type: string, body: string): Ask | null {
  const raw = body.trim()
  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(raw)
  } catch (err) {
    log.warn('ask payload is not valid JSON', { askId, type, raw, err: String(err) })
    return null
  }
  if (typeof parsedJson !== 'object' || parsedJson === null) {
    log.warn('ask payload must be a JSON object', { askId, type, raw })
    return null
  }
  const candidate = { type, ...(parsedJson as Record<string, unknown>) }
  const parsed = AskPayload.safeParse(candidate)
  if (!parsed.success) {
    log.warn('ask payload failed Zod validation', {
      askId,
      type,
      issues: parsed.error.issues,
    })
    return null
  }
  return { askId, ...parsed.data }
}
