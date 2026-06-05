'use client'

import { useCallback, useState } from 'react'
import useSWR from 'swr'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { buttonVariants } from '@/components/ui/button'
import type { FileNode } from '@/lib/dev-studio/file-tree'
import { useTranslation } from '@/hooks/use-translation'
import { FilePreviewDialog } from './file-preview-dialog'
import { FileTreeRender } from './file-tree'

interface FileTreePanelProps {
  /** Currently active session id. */
  sessionId: string
}

interface FilesPayload {
  tree: FileNode
}

async function filesFetcher(url: string): Promise<FilesPayload> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Files request failed (${res.status})`)
  return (await res.json()) as FilesPayload
}

/**
 * Files tab content: polls the workspace tree every 5s and renders it as
 * collapsible directories with double-click-to-preview leaves.
 *
 * The preview dialog is co-located so the polling cadence does not interfere
 * with the dialog's own one-shot fetch (which goes to `/files/:path`).
 */
export function FileTreePanel({ sessionId }: FileTreePanelProps) {
  const { t } = useTranslation()
  const { data, error, mutate } = useSWR<FilesPayload>(
    `/api/employee/dev-studio/sessions/${encodeURIComponent(sessionId)}/files`,
    filesFetcher,
    { refreshInterval: 5_000 }
  )
  const [previewFile, setPreviewFile] = useState<FileNode | null>(null)
  const [pendingDelete, setPendingDelete] = useState<FileNode | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  /**
   * Tree-renderer hands us a file node when the operator clicks the trash
   * icon. We only stage it here — actual DELETE waits for the AlertDialog
   * confirmation so the destructive action lives behind a styled prompt
   * instead of a `window.confirm` system modal.
   */
  const handleDeleteRequest = useCallback((file: FileNode) => {
    setDeleteError(null)
    setPendingDelete(file)
  }, [])

  const handleConfirmDelete = useCallback(async () => {
    if (!pendingDelete) return
    // Path is `upload/<filename>` — extract the filename for the URL.
    const filename = pendingDelete.path.slice('upload/'.length)
    try {
      const url = `/api/employee/dev-studio/sessions/${encodeURIComponent(sessionId)}/upload/${encodeURIComponent(filename)}`
      const res = await fetch(url, { method: 'DELETE' })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(body.error ?? `Delete failed (${res.status})`)
      }
      await mutate()
      setPendingDelete(null)
    } catch (e) {
      // Keep the dialog open and surface the error inside it so the operator
      // can decide to retry or cancel without losing the context.
      setDeleteError(e instanceof Error ? e.message : String(e))
    }
  }, [pendingDelete, sessionId, mutate])

  if (error) {
    return (
      <div className='p-4 text-sm text-destructive' data-testid='dev-studio:file-tree-panel:error'>
        {t('devStudio.files.loadFailed', { message: error.message })}
      </div>
    )
  }
  if (!data) {
    return (
      <div
        className='p-4 text-sm text-muted-foreground'
        data-testid='dev-studio:file-tree-panel:loading'
      >
        {t('devStudio.files.loading')}
      </div>
    )
  }

  const pendingFilename = pendingDelete
    ? pendingDelete.path.slice('upload/'.length)
    : ''

  return (
    <>
      <div className='p-2 text-sm' data-testid='dev-studio:file-tree-panel'>
        <FileTreeRender
          node={data.tree}
          onOpen={setPreviewFile}
          onDelete={handleDeleteRequest}
          depth={0}
        />
      </div>
      {previewFile && (
        <FilePreviewDialog
          fileUrl={`/api/employee/dev-studio/sessions/${encodeURIComponent(sessionId)}/files/${previewFile.path
            .split('/')
            .map(encodeURIComponent)
            .join('/')}`}
          file={previewFile}
          onClose={() => setPreviewFile(null)}
        />
      )}
      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(v) => {
          if (!v) {
            setPendingDelete(null)
            setDeleteError(null)
          }
        }}
      >
        <AlertDialogContent data-testid='dev-studio:file-tree-panel:delete-dialog'>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('devStudio.files.uploadDeleteTitle')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('devStudio.files.uploadDeleteBody', { name: pendingFilename })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteError && (
            <p
              className='text-destructive text-sm'
              data-testid='dev-studio:file-tree-panel:delete-error'
            >
              {t('devStudio.files.uploadDeleteFailed', { message: deleteError })}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel data-testid='dev-studio:file-tree-panel:delete-cancel'>
              {t('devStudio.closeConfirm.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmDelete}
              className={buttonVariants({ variant: 'destructive' })}
              data-testid='dev-studio:file-tree-panel:delete-confirm'
            >
              {t('devStudio.files.uploadDeleteAction')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
