/**
 * Streaming extractor for B-protocol markers in AI-generated text.
 *
 * Recognizes three closed tag forms inside a streamed text payload:
 * - `<pipeline>[..json array of strings..]</pipeline>` → workflow node list
 * - `<phase>name</phase>` → current pipeline phase advance
 * - `<title>value</title>` → human-readable task title
 *
 * It also strips (without emitting a marker) any `<answer id="...">...</answer>`
 * tag. `<answer>` is a server→AI scaffolding tag the BFF injects to feed back a
 * user's prior `<ask>` answer; the model occasionally echoes it into its reply,
 * and it must never reach the user. Unlike the markers above it carries
 * attributes, so it is matched by opener prefix rather than the exact `<tag>`
 * form.
 *
 * Tolerates marker boundaries that fall across chunks: any unclosed tag
 * starting near the end of a chunk is held in an internal buffer until the
 * closing tag arrives in a subsequent `consume` call. Malformed payloads
 * (e.g. invalid pipeline JSON) are logged at warn level and not extracted —
 * the raw text is preserved in the cleaned output so the user still sees
 * something rather than a silent drop.
 */
import { createLogger } from '@crewmeld/logger'

const log = createLogger('dev-studio:marker-extractor')

export type Marker =
  | { type: 'pipeline'; phases: string[] }
  | { type: 'phase'; name: string }
  | { type: 'title'; value: string }

const PIPELINE_RE = /<pipeline>([\s\S]*?)<\/pipeline>/g
const PHASE_RE = /<phase>([\s\S]*?)<\/phase>/g
const TITLE_RE = /<title>([\s\S]*?)<\/title>/g
/** Strip-only: `<answer id="...">payload</answer>` (attribute-bearing opener). */
const ANSWER_RE = /<answer\b[^>]*>[\s\S]*?<\/answer>/g

/** Known marker tag names; used to decide whether a trailing `<` should be buffered. */
const KNOWN_TAGS = ['pipeline', 'phase', 'title'] as const

/** Opener prefix of the attribute-bearing `<answer ...>` strip tag. */
const ANSWER_OPEN = '<answer'

/**
 * Returns true when the substring starting at `offset` could be the prefix of
 * any known opening marker tag (`<pipeline>`, `<phase>`, `<title>`) — including
 * the case where only the `<` has been emitted so far.
 */
function looksLikePartialOpenTag(text: string, offset: number): boolean {
  const tail = text.substring(offset)
  for (const tag of KNOWN_TAGS) {
    const open = `<${tag}>`
    // tail is a strict prefix of `<tag>` (e.g. `<`, `<p`, `<pi`, `<pipeline`)
    if (open.startsWith(tail)) return true
    // tail already contains the full opening but no closing tag yet
    if (tail.startsWith(open) && !tail.includes(`</${tag}>`)) return true
  }
  // `<answer ...>` carries attributes, so its opener is matched by prefix
  // (`<answer`) rather than the exact `<answer>` form used by the markers above.
  if (ANSWER_OPEN.startsWith(tail)) return true
  if (tail.startsWith(ANSWER_OPEN) && !tail.includes('</answer>')) return true
  return false
}

/**
 * Locates the boundary where the trailing portion of `text` may be an
 * unfinished marker that should be carried over to the next chunk.
 *
 * Walks **left-to-right** and returns the offset of the leftmost `<` whose
 * suffix could still grow into a known marker tag. A right-to-left scan would
 * pick the closing-tag `<` (e.g. the `<` of `</phase>`) when a full opening
 * tag is already pending, splitting in the middle and leaking the opening
 * into the cleaned stream.
 *
 * @returns offset to split at, or `text.length` when nothing needs buffering.
 */
function findPendingSplit(text: string): number {
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '<' && looksLikePartialOpenTag(text, i)) {
      return i
    }
  }
  return text.length
}

export class MarkerExtractor {
  private buffer = ''

  /**
   * Feed a streamed text chunk, returning any newly-completed markers plus
   * the cleaned text with markers stripped. Partial markers at the tail of
   * the cumulative buffer are retained internally for the next call.
   */
  consume(text: string): { cleaned: string; markers: Marker[] } {
    const combined = this.buffer + text
    const markers: Marker[] = []

    let scratch = combined.replace(PIPELINE_RE, (match, body: string) => {
      const raw = body.trim()
      try {
        const phases = JSON.parse(raw) as unknown
        if (Array.isArray(phases) && phases.every((p) => typeof p === 'string')) {
          if (phases.length === 0) {
            log.warn('pipeline marker payload is an empty array — ignored', { raw })
            return match
          }
          markers.push({ type: 'pipeline', phases: phases as string[] })
          return ''
        }
        log.warn('pipeline marker payload is not a string[]', { raw })
        return match
      } catch (err) {
        log.warn('malformed pipeline marker JSON', { raw, err: String(err) })
        return match
      }
    })

    scratch = scratch.replace(PHASE_RE, (_match, name: string) => {
      markers.push({ type: 'phase', name: name.trim() })
      return ''
    })

    scratch = scratch.replace(TITLE_RE, (_match, value: string) => {
      markers.push({ type: 'title', value: value.trim() })
      return ''
    })

    // Strip-only: drop any complete <answer ...>...</answer> the model echoed.
    scratch = scratch.replace(ANSWER_RE, '')

    const splitAt = findPendingSplit(scratch)
    if (splitAt < scratch.length) {
      this.buffer = scratch.substring(splitAt)
      return { cleaned: scratch.substring(0, splitAt), markers }
    }
    this.buffer = ''
    return { cleaned: scratch, markers }
  }
}
