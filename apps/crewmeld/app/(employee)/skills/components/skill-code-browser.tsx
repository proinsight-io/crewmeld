'use client'

import { useState } from 'react'
import useSWR from 'swr'
import type { FileNode } from '@/lib/dev-studio/file-tree'
import { useTranslation } from '@/hooks/use-translation'
import { FilePreviewDialog } from './dev-studio/file-preview-dialog'
import { FileTreeRender } from './dev-studio/file-tree'

interface FilesResponse {
  data: { tree: FileNode }
}

async function toolFilesFetcher(url: string): Promise<FileNode> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Files request failed (${res.status})`)
  const body = (await res.json()) as FilesResponse
  return body.data.tree
}

/**
 * Read-only browser for a dev-studio tool's NFS code directory. Lists the
 * file tree and opens a syntax-highlighted preview on double-click. Editing
 * code requires re-opening Dev Studio, so no write affordances are offered.
 *
 * Reuses the dev-studio `FileTreeRender` + `FilePreviewDialog`; the preview
 * URL is tool-scoped (`/api/employee/skills/:toolId/files/:path`).
 */
export function SkillCodeBrowser({ toolId }: { toolId: string }) {
  const { t } = useTranslation()
  const { data: tree, error } = useSWR<FileNode>(
    `/api/employee/skills/${encodeURIComponent(toolId)}/files`,
    toolFilesFetcher
  )
  const [previewFile, setPreviewFile] = useState<FileNode | null>(null)

  if (error) {
    return (
      <p className='text-amber-600 text-xs' data-testid='skills:code-browser:error'>
        {t('devStudio.files.loadFailed', { message: error.message })}
      </p>
    )
  }
  if (!tree) {
    return (
      <p className='text-gray-400 text-xs' data-testid='skills:code-browser:loading'>
        {t('devStudio.files.loading')}
      </p>
    )
  }
  if (!tree.children || tree.children.length === 0) {
    return (
      <p className='text-gray-400 text-xs' data-testid='skills:code-browser:empty'>
        {t('skills.codeBrowserEmpty')}
      </p>
    )
  }

  return (
    <>
      <div className='text-sm' data-testid='skills:code-browser'>
        <FileTreeRender node={tree} onOpen={setPreviewFile} depth={0} />
      </div>
      {previewFile && (
        <FilePreviewDialog
          fileUrl={`/api/employee/skills/${encodeURIComponent(toolId)}/files/${previewFile.path
            .split('/')
            .map(encodeURIComponent)
            .join('/')}`}
          file={previewFile}
          onClose={() => setPreviewFile(null)}
        />
      )}
    </>
  )
}
