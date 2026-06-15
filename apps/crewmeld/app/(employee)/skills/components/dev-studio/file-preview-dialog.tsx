'use client'

import { useEffect, useState } from 'react'
import { Highlight, themes } from 'prism-react-renderer'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/core/utils/cn'
import type { FileNode } from '@/lib/dev-studio/file-tree'
import { useTranslation } from '@/hooks/use-translation'
import { formatBytes } from './file-tree'

interface FilePreviewDialogProps {
  /**
   * Fully-formed URL the dialog fetches text from and links downloads to.
   * The caller builds it (session-scoped or tool-scoped) so this dialog stays
   * agnostic of which backend surface the file lives on.
   */
  fileUrl: string
  /** Selected file node — only `path` / `name` / `size` are read. */
  file: FileNode
  onClose: () => void
}

type Kind = 'text' | 'image' | 'pdf' | 'binary'

/**
 * Tiny extension → preview kind classifier. The BFF already decides the
 * canonical mime; we mirror just enough of the same table here so the dialog
 * can pick a renderer without a HEAD round-trip.
 */
function classify(name: string): Kind {
  const lower = name.toLowerCase()
  const dot = lower.lastIndexOf('.')
  const ext = dot >= 0 ? lower.slice(dot) : ''
  if (
    [
      '.txt',
      '.md',
      '.log',
      '.json',
      '.yml',
      '.yaml',
      '.xml',
      '.html',
      '.htm',
      '.css',
      '.js',
      '.mjs',
      '.cjs',
      '.ts',
      '.tsx',
      '.jsx',
      '.py',
      '.sh',
      '.toml',
      '.ini',
      '.env',
      '.csv',
    ].includes(ext)
  ) {
    return 'text'
  }
  if (['.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico'].includes(ext)) {
    return 'image'
  }
  if (ext === '.pdf') return 'pdf'
  return 'binary'
}

/**
 * Extension → Prism language id. Returns `null` for formats with no useful
 * grammar (plain text, csv, ini), which fall back to an unhighlighted `<pre>`.
 */
const PRISM_LANG_BY_EXT: Record<string, string> = {
  '.py': 'python',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'jsx',
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.json': 'json',
  '.sh': 'bash',
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.html': 'markup',
  '.htm': 'markup',
  '.xml': 'markup',
  '.svg': 'markup',
  '.css': 'css',
  '.md': 'markdown',
}

function prismLangForName(name: string): string | null {
  const lower = name.toLowerCase()
  const dot = lower.lastIndexOf('.')
  const ext = dot >= 0 ? lower.slice(dot) : ''
  return PRISM_LANG_BY_EXT[ext] ?? null
}

/**
 * Preview a single file. The fetch/download URL is supplied by the caller
 * (`fileUrl`); the renderer is chosen from the basename extension:
 *   - text/json/markdown/...  → fetch text() into a syntax-highlighted block
 *     (Prism via prism-react-renderer; plain `<pre>` for grammar-less formats).
 *   - image                   → <img src=fileUrl>.
 *   - pdf                     → <iframe src=fileUrl>.
 *   - everything else         → download affordance only.
 *
 * The text branch performs one network call on mount; sizes above the BFF
 * cap (1 MiB) come back as 412 and surface as a "too large" affordance.
 */
export function FilePreviewDialog({ fileUrl, file, onClose }: FilePreviewDialogProps) {
  const { t } = useTranslation()
  const kind = classify(file.name)
  const lang = prismLangForName(file.name)

  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(kind === 'text')

  useEffect(() => {
    if (kind !== 'text') return
    let cancelled = false
    setLoading(true)
    setError(null)
    setText(null)
    ;(async () => {
      try {
        const res = await fetch(fileUrl)
        if (res.status === 412) {
          if (!cancelled) setError(t('devStudio.preview.tooLarge'))
          return
        }
        if (!res.ok) {
          if (!cancelled) setError(t('devStudio.preview.loadFailed', { status: res.status }))
          return
        }
        const body = await res.text()
        if (!cancelled) setText(body)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [fileUrl, kind, t])

  return (
    <Dialog
      open
      // Non-modal: this preview is opened on top of another custom modal
      // (the tool editor). A modal Radix dialog locks `document.body`'s
      // pointer-events and, when unmounted abruptly on close, can leave the
      // body inert — freezing the parent editor's backdrop and buttons.
      modal={false}
      onOpenChange={(v) => {
        if (!v) onClose()
      }}
    >
      <DialogContent className='max-w-3xl' data-testid='dev-studio:file-preview-dialog'>
        <DialogTitle>{file.name}</DialogTitle>
        <DialogDescription>
          {file.path} · {formatBytes(file.size ?? 0)}
        </DialogDescription>

        <div className='max-h-[60vh] overflow-auto rounded border bg-muted/30'>
          {kind === 'text' && loading && (
            <div className='p-3 text-sm text-muted-foreground'>
              {t('devStudio.preview.loading')}
            </div>
          )}
          {kind === 'text' && error && (
            <div
              className='p-3 text-sm text-destructive'
              data-testid='dev-studio:file-preview-dialog:error'
            >
              {error}
            </div>
          )}
          {kind === 'text' && text !== null && lang !== null && (
            <Highlight code={text} language={lang} theme={themes.vsDark}>
              {({ className, style, tokens, getLineProps, getTokenProps }) => (
                <pre
                  className={cn(className, 'overflow-auto p-3 font-mono text-xs leading-5')}
                  style={style}
                  data-testid='dev-studio:file-preview-dialog:text'
                >
                  {tokens.map((line, lineIdx) => (
                    <div key={`line-${lineIdx}`} {...getLineProps({ line })}>
                      {line.map((token, tokIdx) => (
                        <span key={`tok-${lineIdx}-${tokIdx}`} {...getTokenProps({ token })} />
                      ))}
                    </div>
                  ))}
                </pre>
              )}
            </Highlight>
          )}
          {kind === 'text' && text !== null && lang === null && (
            <pre
              className='whitespace-pre-wrap break-words p-3 font-mono text-xs'
              data-testid='dev-studio:file-preview-dialog:text'
            >
              {text}
            </pre>
          )}
          {kind === 'image' && (
            <img
              src={fileUrl}
              alt={file.name}
              className='mx-auto block max-h-[60vh] object-contain'
              data-testid='dev-studio:file-preview-dialog:image'
            />
          )}
          {kind === 'pdf' && (
            <iframe
              src={fileUrl}
              title={file.name}
              className='h-[60vh] w-full'
              data-testid='dev-studio:file-preview-dialog:pdf'
            />
          )}
          {kind === 'binary' && (
            <div
              className='p-4 text-sm text-muted-foreground'
              data-testid='dev-studio:file-preview-dialog:binary'
            >
              {t('devStudio.preview.binary')}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button asChild variant='outline' type='button'>
            <a
              href={fileUrl}
              download={file.name}
              data-testid='dev-studio:file-preview-dialog:download'
            >
              {t('devStudio.preview.download')}
            </a>
          </Button>
          <Button type='button' onClick={onClose}>
            {t('devStudio.preview.close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
