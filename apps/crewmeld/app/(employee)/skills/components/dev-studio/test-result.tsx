'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/core/utils/cn'
import type { ManifestT } from '@/lib/dev-studio/manifest-reader'
import { useTranslation } from '@/hooks/use-translation'
import { formatBytes } from './file-tree'

/** Subset of {@link openSandbox.ExecResult} the result panel cares about. */
export interface ExecResultShape {
  stdout: string
  stderr: string
  exitCode: number
  durationMs: number
  /** Present only for `kind=service` runs (parsed from the trailing curl line). */
  httpStatus?: number
}

/** Shape returned by `POST /run-test`: runner result + optional file list. */
export interface RunTestResult {
  result: ExecResultShape
  files?: Array<{ path: string; size: number; mime: string }>
}

interface TestResultProps {
  result: RunTestResult
  manifest: ManifestT
  sessionId: string
  /**
   * Tool execution id for the current run. When set, the preview view fetches
   * the toolIo file listing
   * (`/api/employee/tool-execution/<execId>/files`) and renders download
   * links pointing at the per-file API. Needed for `output.type=files / pdf /
   * image` tools where the binary product lives in toolIo, not in the
   * run-test SSE stream.
   */
  executionId?: string
  /** When true the sandbox was retained on failure for log inspection. */
  kept?: boolean
  /** Callback to open the log viewer modal (shown when `kept` is true). */
  onViewLog?: () => void
}

type View = 'preview' | 'raw'

/**
 * Dual-view result panel rendered below the param form once the operator
 * fires a test run.
 *
 * Default view is decided by the run's exit code: success → preview (operator
 * cares about the artefact), failure → raw (operator needs to see stderr).
 * Both views remain accessible via the toggle so a successful run can still
 * be inspected raw.
 */
export function TestResult({
  result,
  manifest,
  sessionId,
  executionId,
  kept,
  onViewLog,
}: TestResultProps) {
  const { t } = useTranslation()
  const ok = result.result.exitCode === 0
  const [view, setView] = useState<View>(ok ? 'preview' : 'raw')

  return (
    <div className='rounded border p-3' data-testid='dev-studio:test-result'>
      <div className='mb-2 flex items-center justify-between'>
        <div className='flex gap-1'>
          <Button
            type='button'
            size='sm'
            variant={view === 'preview' ? 'default' : 'outline'}
            onClick={() => setView('preview')}
            data-testid='dev-studio:test-result:toggle:preview'
          >
            {t('devStudio.test.resultPreview')}
          </Button>
          <Button
            type='button'
            size='sm'
            variant={view === 'raw' ? 'default' : 'outline'}
            onClick={() => setView('raw')}
            data-testid='dev-studio:test-result:toggle:raw'
          >
            {t('devStudio.test.resultRaw')}
          </Button>
          {kept && onViewLog && (
            <Button
              type='button'
              size='sm'
              variant='outline'
              onClick={onViewLog}
              data-testid='dev-studio:test-result:view-log'
            >
              {t('devStudio.test.viewLog')}
            </Button>
          )}
        </div>
        <span
          className={cn(
            'text-xs',
            ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive'
          )}
          data-testid='dev-studio:test-result:status'
        >
          {ok ? t('devStudio.test.resultSuccess') : t('devStudio.test.resultFailed')} ·{' '}
          {result.result.durationMs}ms · exit {result.result.exitCode}
          {result.result.httpStatus !== undefined && ` · http ${result.result.httpStatus}`}
        </span>
      </div>
      {view === 'preview' ? (
        <PreviewView
          result={result}
          manifest={manifest}
          sessionId={sessionId}
          executionId={executionId}
        />
      ) : (
        <RawView result={result.result} />
      )}
    </div>
  )
}

function PreviewView({ result, manifest, sessionId, executionId }: TestResultProps) {
  const { t } = useTranslation()
  const outputType = manifest.output.type
  const showFileList = outputType === 'files' || outputType === 'pdf' || outputType === 'image'

  // Pull the list straight out of toolIo for file-producing tools. Two
  // fallbacks keep older / synchronous code paths working:
  //   - When the runner already provided `result.files` (legacy SSE
  //     attachment), we use that and skip the fetch.
  //   - When no executionId is in scope (e.g. test rendering outside the
  //     run-test flow), we fall through to the type-specific branches.
  const fallbackList = result.files
  const hasFallback = Array.isArray(fallbackList) && fallbackList.length > 0
  const fetchKey =
    showFileList && !hasFallback && executionId
      ? `/api/employee/tool-execution/${encodeURIComponent(executionId)}/files`
      : null
  const { data: fetchedList } = useSWR<{ files: Array<{ name: string; size: number; mtime: string }> }>(
    fetchKey,
    async (url: string) => {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`Files list failed (${res.status})`)
      return (await res.json()) as { files: Array<{ name: string; size: number; mtime: string }> }
    }
  )

  if (showFileList && (hasFallback || (fetchedList && fetchedList.files.length > 0))) {
    const items = hasFallback
      ? (fallbackList ?? []).map((f) => ({ name: f.path, size: f.size }))
      : (fetchedList?.files ?? []).map((f) => ({ name: f.name, size: f.size }))
    return (
      <div className='space-y-1 font-mono text-xs' data-testid='dev-studio:test-result:preview'>
        {items.map((f) => {
          // tool-execution route uses the per-filename API:
          // /api/employee/tool-execution/<execId>/files/<filename>.
          // When executionId is missing (test fixtures), fall back to the
          // legacy session-files API so older snapshot tests still resolve.
          const href = executionId
            ? `/api/employee/tool-execution/${encodeURIComponent(executionId)}/files/${encodeURIComponent(f.name)}`
            : `/api/employee/dev-studio/sessions/${encodeURIComponent(sessionId)}/files/${f.name
                .split('/')
                .map(encodeURIComponent)
                .join('/')}`
          return (
            <div key={f.name}>
              <span aria-hidden='true'>📄 </span>
              {f.name} <span className='text-muted-foreground'>({formatBytes(f.size)})</span>
              <a
                href={href}
                target='_blank'
                rel='noreferrer'
                className='ml-2 text-primary underline'
                data-testid={`dev-studio:test-result:file-preview:${f.name}`}
              >
                {t('devStudio.test.filePreview')}
              </a>
              <a
                href={href}
                download
                className='ml-2 text-primary underline'
                data-testid={`dev-studio:test-result:file-download:${f.name}`}
              >
                {t('devStudio.test.fileDownload')}
              </a>
            </div>
          )
        })}
      </div>
    )
  }

  if (outputType === 'json') {
    let body = result.result.stdout
    try {
      const parsed = JSON.parse(result.result.stdout)
      body = JSON.stringify(parsed, null, 2)
    } catch {
      // Fall through with raw stdout.
    }
    return (
      <pre
        className='overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-2 text-xs'
        data-testid='dev-studio:test-result:preview'
      >
        {body}
      </pre>
    )
  }

  if (outputType === 'text') {
    return (
      <pre
        className='overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-2 text-xs'
        data-testid='dev-studio:test-result:preview'
      >
        {result.result.stdout}
      </pre>
    )
  }

  // image / pdf — without a files array we have nothing visual to anchor on;
  // fall back to the raw view so the operator at least sees stdout/stderr.
  return <RawView result={result.result} />
}

function RawView({ result }: { result: ExecResultShape }) {
  const { t } = useTranslation()
  const stdoutLines = result.stdout ? result.stdout.split('\n').length : 0
  const stderrLines = result.stderr ? result.stderr.split('\n').length : 0
  return (
    <div className='space-y-2 font-mono text-xs' data-testid='dev-studio:test-result:raw'>
      <details open>
        <summary className='cursor-pointer select-none'>
          {t('devStudio.test.stdoutLines', { lines: stdoutLines })}
        </summary>
        <pre className='mt-1 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-2'>
          {result.stdout || '(empty)'}
        </pre>
      </details>
      <details open={result.stderr.length > 0}>
        <summary className='cursor-pointer select-none'>
          {t('devStudio.test.stderrLines', { lines: stderrLines })}
        </summary>
        <pre className='mt-1 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-2'>
          {result.stderr || '(empty)'}
        </pre>
      </details>
      <div className='text-muted-foreground'>
        {t('devStudio.test.resultExit')}: {result.exitCode} · {t('devStudio.test.resultDuration')}:{' '}
        {result.durationMs}ms
        {result.httpStatus !== undefined && ` · http: ${result.httpStatus}`}
      </div>
    </div>
  )
}
