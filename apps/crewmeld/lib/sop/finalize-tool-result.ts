/**
 * Finalize a raw tool response into the shape the SOP loop consumes.
 *
 * In the synchronous path this logic lived inline in `llm-tool-executor.ts`,
 * running right after a tool returned. In the async path a tool's result
 * arrives later via callback, so the same processing must happen there before
 * the result is journaled to `work_logs`. Extracted verbatim so both paths
 * (and any future caller) produce identical results:
 *
 *   1. Same-SOP filename collision handling — rename a colliding output file to
 *      `<base>(N)<ext>` on disk and update the result's `output_file(s)`.
 *   2. `download_url` / `download_urls` injection so the LLM copies a ready-made
 *      link instead of constructing one (and stripping the `sop_` prefix).
 *   3. Files extraction (top-level or nested under `result`).
 *   4. Building the LLM-facing `resultContent` string (base64 stripped) and the
 *      structured `output` object the engine forwards to the conversation.
 */
import { createLogger } from '@crewmeld/logger'
import { t } from '@/lib/core/server-i18n'

const logger = createLogger('FinalizeToolResult')

/** File attachment shape carried through tool results (base64 payload). */
export interface ToolResultFile {
  name: string
  mimeType: string
  base64: string
}

/** Raw envelope a tool returns: `{ success, result?, error?, files? }`. */
export interface RawToolEnvelope {
  success: boolean
  result?: unknown
  error?: string
  files?: ToolResultFile[]
}

export interface FinalizeToolResultCtx {
  /** Set on the production SOP path; enables file-collision + download_url handling. */
  sopExecutionId?: string
  /** Public URL prefix for download links; pairs with sopExecutionId. */
  sopFileUrlPrefix?: string
}

export interface FinalizedToolResult {
  success: boolean
  /** Stored as the log's `metadata.output` and surfaced to the SOP engine. */
  output: Record<string, unknown>
  /** Exact string fed back to the LLM as the tool message content. */
  resultContent: string
  /** Extracted files (base64) for conversation delivery, if any. */
  files?: ToolResultFile[]
  error?: string
}

/**
 * Process a raw tool envelope. Pure except for the on-disk rename of colliding
 * output files (best-effort; failures keep the original name). Never throws.
 */
export async function finalizeToolResult(
  raw: RawToolEnvelope,
  ctx: FinalizeToolResultCtx
): Promise<FinalizedToolResult> {
  const { sopExecutionId, sopFileUrlPrefix } = ctx

  // 1 + 2. Same-SOP filename collisions + download_url injection (success only,
  // file-mount tools, production SOP path).
  if (sopExecutionId && sopFileUrlPrefix && raw.success && raw.result && typeof raw.result === 'object') {
    const inner = raw.result as Record<string, unknown>
    const { resolveUniqueName } = await import('./sop-files-workspace')
    const { paths: devStudioPaths } = await import('@/lib/dev-studio/paths')
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    const sopDir = devStudioPaths.sopFiles.forBff(sopExecutionId)

    if (typeof inner.output_file === 'string') {
      const original = inner.output_file
      const finalName = await resolveUniqueName(sopExecutionId, original)
      if (finalName !== original) {
        try {
          await fs.rename(path.join(sopDir, original), path.join(sopDir, finalName))
          inner.output_file = finalName
          logger.info('Renamed output file to avoid collision', { sopExecutionId, from: original, to: finalName })
        } catch (err) {
          logger.warn('Failed to rename colliding output file; keeping original name', {
            sopExecutionId,
            original,
            attemptedFinal: finalName,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
      if (!inner.download_url) {
        inner.download_url = `${sopFileUrlPrefix}/${encodeURIComponent(inner.output_file as string)}`
      }
    }

    if (Array.isArray(inner.output_files) && inner.output_files.every((x) => typeof x === 'string')) {
      const originals = inner.output_files as string[]
      const finals: string[] = []
      for (const original of originals) {
        const finalName = await resolveUniqueName(sopExecutionId, original)
        if (finalName !== original) {
          try {
            await fs.rename(path.join(sopDir, original), path.join(sopDir, finalName))
            finals.push(finalName)
            logger.info('Renamed output file to avoid collision (batch)', { sopExecutionId, from: original, to: finalName })
          } catch (err) {
            logger.warn('Failed to rename colliding output file in batch; keeping original', {
              sopExecutionId,
              original,
              attemptedFinal: finalName,
              error: err instanceof Error ? err.message : String(err),
            })
            finals.push(original)
          }
        } else {
          finals.push(original)
        }
      }
      inner.output_files = finals
      if (!inner.download_urls) {
        inner.download_urls = finals.map((name) => `${sopFileUrlPrefix}/${encodeURIComponent(name)}`)
      }
    }
  }

  // 3. Smart files extraction: top-level files, else files nested in result.
  let files = raw.files
  if (!files || !Array.isArray(files) || files.length === 0) {
    const nested = raw.result as Record<string, unknown> | undefined
    if (nested && typeof nested === 'object' && Array.isArray(nested.files) && nested.files.length > 0) {
      files = nested.files as ToolResultFile[]
    }
  }

  // 4. Build resultContent (LLM-facing) + output (engine-facing).
  if (raw.success) {
    let output: string
    if (typeof raw.result === 'string') {
      output = raw.result
    } else {
      // Strip base64 from files before handing to the LLM so it never echoes raw encoding.
      const sanitized = { ...((raw.result as Record<string, unknown>) ?? {}) }
      if (Array.isArray(sanitized.files)) {
        sanitized.files = (sanitized.files as Array<Record<string, unknown>>).map((f) => ({
          name: f.name,
          mimeType: f.mimeType,
        }))
      }
      output = JSON.stringify(sanitized, null, 2)
    }
    if (files && files.length > 0) {
      const fileList = files.map((f) => f.name).join(', ')
      output += `\n\n[${t('sopFileGenerated', undefined, { files: fileList })}]`
    }

    const toolOutput: Record<string, unknown> = { result: raw.result ?? null }
    if (files && files.length > 0) toolOutput.files = files

    return { success: true, output: toolOutput, resultContent: output, files }
  }

  const error = raw.error ?? 'Unknown error'
  return {
    success: false,
    output: { error },
    resultContent: `Tool execution failed: ${error}`,
    error,
  }
}
