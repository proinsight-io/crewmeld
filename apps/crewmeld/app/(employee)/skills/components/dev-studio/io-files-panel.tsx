'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { Button } from '@/components/ui/button'
import { formatBytes } from './file-tree'
import { useTranslation } from '@/hooks/use-translation'

/**
 * Operator-facing list of the per-session run-test inputs at
 * `<bff-root>/io/session/<Y>/<M>/<D>/<sessionId>/`.
 *
 * Surfaces two actions:
 *   - List files (SWR-cached on the same key the schema-form file picker uses;
 *     uploads from the picker appear here automatically).
 *   - Delete a file (DELETE on the same URL; idempotent — propagates to the
 *     picker via the shared SWR cache).
 *
 * Uploads themselves live in the schema form's FileFieldControl so each file
 * parameter gets a one-click upload + autofill. The panel renders above the
 * schema form in {@link TestPanel} so the operator can review and clean up
 * existing inputs before filling the run parameters.
 */
export interface IoFilesPanelProps {
  sessionId: string
}

interface IoFileEntry {
  name: string
  size: number
  mtime: string
}

interface IoFilesResponse {
  files: IoFileEntry[]
}

const FILE_LIST_KEY = (sessionId: string): string =>
  `/api/employee/dev-studio/sessions/${encodeURIComponent(sessionId)}/io`

async function filesFetcher(url: string): Promise<IoFilesResponse> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Files list failed (${res.status})`)
  return (await res.json()) as IoFilesResponse
}

export function IoFilesPanel({ sessionId }: IoFilesPanelProps) {
  const { t } = useTranslation()
  const [errMsg, setErrMsg] = useState<string | null>(null)

  const { data, mutate } = useSWR<IoFilesResponse>(FILE_LIST_KEY(sessionId), filesFetcher)
  const files = data?.files ?? []

  const onDelete = async (name: string): Promise<void> => {
    setErrMsg(null)
    try {
      const url = `/api/employee/dev-studio/sessions/${encodeURIComponent(sessionId)}/io/${encodeURIComponent(name)}`
      const res = await fetch(url, { method: 'DELETE' })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(body.error ?? `Delete failed (${res.status})`)
      }
      await mutate()
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div
      className='space-y-2 rounded border p-3'
      data-testid='dev-studio:io-files-panel'
    >
      <h4 className='font-medium text-sm'>{t('devStudio.test.ioFilesTitle')}</h4>

      {files.length === 0 ? (
        <p className='text-muted-foreground text-xs' data-testid='dev-studio:io-files-panel:empty'>
          {t('devStudio.test.ioFilesEmpty')}
        </p>
      ) : (
        <ul className='space-y-1'>
          {files.map((f) => (
            <li
              key={f.name}
              className='flex items-center justify-between rounded px-1 py-0.5 text-sm hover:bg-accent'
              data-testid={`dev-studio:io-files-panel:row:${f.name}`}
            >
              <span className='truncate'>
                <span aria-hidden='true'>📎 </span>
                {f.name}{' '}
                <span className='text-muted-foreground text-xs'>{formatBytes(f.size)}</span>
              </span>
              <Button
                type='button'
                variant='ghost'
                size='sm'
                onClick={() => onDelete(f.name)}
                data-testid={`dev-studio:io-files-panel:delete:${f.name}`}
              >
                {t('devStudio.test.ioFilesDelete')}
              </Button>
            </li>
          ))}
        </ul>
      )}

      {errMsg && (
        <p className='text-destructive text-xs' data-testid='dev-studio:io-files-panel:error'>
          {errMsg}
        </p>
      )}
    </div>
  )
}
