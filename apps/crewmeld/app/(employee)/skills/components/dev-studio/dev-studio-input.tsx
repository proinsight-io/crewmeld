'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, Plus, Send, Sparkles, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { useTranslation } from '@/hooks/use-translation'
import { SlashCommandMenu } from './slash-command-menu'

interface Props {
  busy: boolean
  disabled: boolean
  isFirstMessage: boolean
  sessionId: string | null
  onSend: (text: string) => void
  onAbort: () => void
}

export function DevStudioInput({
  busy,
  disabled,
  isFirstMessage,
  sessionId,
  onSend,
  onAbort,
}: Props) {
  const { t } = useTranslation()
  const [text, setText] = useState('')
  const taRef = useRef<HTMLTextAreaElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)

  // ── Upload state (reference files written to <workspace>/upload/) ──
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadedSinceLastSend, setUploadedSinceLastSend] = useState<string[]>([])
  const [uploadError, setUploadError] = useState<string | null>(null)

  // Slash menu: open iff input starts with `/` and contains no whitespace.
  const slashState = useMemo(() => {
    const m = text.match(/^\/(\S*)$/)
    return m ? { open: true, query: m[1] } : { open: false, query: '' }
  }, [text])

  useEffect(() => {
    setMenuOpen(slashState.open)
  }, [slashState.open])

  // Auto-grow the textarea up to half the viewport so long pasted prompts
  // are fully visible without manual resizing, but never push the chat area
  // below half-screen — past the cap the textarea internally scrolls.
  useEffect(() => {
    const ta = taRef.current
    if (!ta) return
    // Reset before measuring; scrollHeight reflects the content height only
    // after we collapse the box first, otherwise it stays at its current
    // (possibly grown) height.
    ta.style.height = 'auto'
    const max = typeof window !== 'undefined' ? Math.floor(window.innerHeight * 0.5) : 480
    ta.style.height = `${Math.min(ta.scrollHeight, max)}px`
  }, [text])

  // ESC handler:
  // - If slash menu open → SlashCommandMenu owns ESC (closes menu)
  // - If busy AND (focus outside textarea OR textarea is empty) → trigger abort
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      if (menuOpen) return // menu handles ESC
      if (!busy) return
      const ta = taRef.current
      const inEmptyTextarea = document.activeElement === ta && text.length === 0
      const outsideTextarea = document.activeElement !== ta
      if (inEmptyTextarea || outsideTextarea) {
        e.preventDefault()
        onAbort()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, text, menuOpen, onAbort])

  function handleSend() {
    const t = text.trim()
    if (!t || busy || disabled) return
    onSend(t)
    setText('')
    // Uploaded files have been announced to the AI on this turn; clear the
    // local chip so the operator doesn't see a stale count on the next turn.
    setUploadedSinceLastSend([])
    setUploadError(null)
  }

  function handleSelectCommand(englishName: string) {
    setText(`/${englishName} `)
    setMenuOpen(false)
    taRef.current?.focus()
  }

  function handleUploadClick() {
    if (uploading || !sessionId) return
    fileInputRef.current?.click()
  }

  async function handleFilesPicked(event: React.ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(event.target.files ?? [])
    // Reset native input so re-picking the same file in a row still fires change.
    event.target.value = ''
    if (picked.length === 0 || !sessionId) return

    setUploading(true)
    setUploadError(null)
    const succeeded: string[] = []
    try {
      // Serial upload — keeps NFS happy and gives deterministic notice ordering.
      for (const file of picked) {
        const fd = new FormData()
        fd.append('file', file)
        const url = `/api/employee/dev-studio/sessions/${encodeURIComponent(sessionId)}/upload/${encodeURIComponent(file.name)}`
        const res = await fetch(url, { method: 'POST', body: fd })
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string }
          throw new Error(body.error ?? `Upload failed (${res.status})`)
        }
        succeeded.push(file.name)
      }
      setUploadedSinceLastSend((prev) => [...prev, ...succeeded])
    } catch (e) {
      // Keep the names that *did* succeed visible — the operator should know
      // partial progress so they can re-pick only the failures.
      if (succeeded.length > 0) {
        setUploadedSinceLastSend((prev) => [...prev, ...succeeded])
      }
      setUploadError(e instanceof Error ? e.message : String(e))
    } finally {
      setUploading(false)
    }
  }

  const uploadDisabled = uploading || disabled || !sessionId
  const uploadCount = uploadedSinceLastSend.length

  return (
    <div className='relative border-t p-3' data-testid='dev-studio:input-area'>
      <SlashCommandMenu
        open={menuOpen}
        query={slashState.query}
        onSelect={handleSelectCommand}
        onClose={() => setMenuOpen(false)}
      />
      <Textarea
        ref={taRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        disabled={disabled}
        data-testid='dev-studio:input-textarea'
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault()
            handleSend()
          }
        }}
        placeholder={t('devStudio.chat.placeholder')}
        rows={3}
        // resize-none because the effect above already auto-grows; letting
        // the browser drag-resize would race with the auto-grow on each
        // keystroke (browser height gets clobbered).
        className='resize-none overflow-y-auto'
      />
      <div className='flex items-center justify-between mt-2 gap-2'>
        <div className='flex items-center gap-2 min-w-0'>
          <button
            type='button'
            onClick={handleUploadClick}
            disabled={uploadDisabled}
            title={t('devStudio.chat.uploadTooltip')}
            aria-label={t('devStudio.chat.uploadTooltip')}
            className='flex size-8 shrink-0 items-center justify-center rounded-full border bg-background text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50'
            data-testid='dev-studio:upload-button'
          >
            {uploading ? (
              <Loader2 className='size-4 animate-spin' />
            ) : (
              <Plus className='size-4' />
            )}
          </button>
          <input
            ref={fileInputRef}
            type='file'
            multiple
            className='hidden'
            onChange={handleFilesPicked}
            data-testid='dev-studio:upload-native-input'
          />
          {uploadCount > 0 && (
            <span
              className='truncate rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground'
              title={uploadedSinceLastSend.join('\n')}
              data-testid='dev-studio:upload-chip'
            >
              {t('devStudio.chat.uploadedChip', { count: uploadCount })}
            </span>
          )}
          {uploadError && (
            <span
              className='truncate text-destructive text-xs'
              data-testid='dev-studio:upload-error'
            >
              {uploadError}
            </span>
          )}
          {uploadCount === 0 && !uploadError && isFirstMessage && !text.startsWith('/') && (
            <span className='flex items-center gap-1 text-xs text-muted-foreground'>
              <Sparkles className='size-3' />
              {t('devStudio.chat.firstMessageHint')}
            </span>
          )}
        </div>
        {busy ? (
          <Button variant='destructive' onClick={onAbort} data-testid='dev-studio:abort-button'>
            <Square className='size-4 mr-1.5' />
            {t('devStudio.chat.stop')}
          </Button>
        ) : (
          <Button
            onClick={handleSend}
            disabled={!text.trim() || disabled}
            data-testid='dev-studio:send-button'
          >
            <Send className='size-4 mr-1.5' />
            {t('devStudio.chat.send')}
          </Button>
        )}
      </div>
    </div>
  )
}
