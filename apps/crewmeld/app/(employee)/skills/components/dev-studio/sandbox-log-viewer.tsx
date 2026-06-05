'use client'

import { useEffect, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useTranslation } from '@/hooks/use-translation'

interface SandboxLogViewerProps {
  sessionId: string
  sandboxId: string
  open: boolean
  onClose: () => void
}

/**
 * Modal that fetches and displays container logs from a retained sandbox.
 * When the retain window has expired (HTTP 410), a localised "log expired"
 * message is shown instead.
 */
export function SandboxLogViewer({ sessionId, sandboxId, open, onClose }: SandboxLogViewerProps) {
  const { t } = useTranslation()
  const [logText, setLogText] = useState<string | null>(null)
  const [expired, setExpired] = useState(false)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open) {
      setLogText(null)
      setExpired(false)
      return
    }

    let cancelled = false

    async function fetchLog() {
      setLoading(true)
      try {
        const url = `/api/employee/dev-studio/sessions/${encodeURIComponent(sessionId)}/run-test/log?sandboxId=${encodeURIComponent(sandboxId)}`
        const res = await fetch(url)
        if (cancelled) return
        if (res.status === 410) {
          setExpired(true)
          return
        }
        if (!res.ok) {
          setLogText(`Error: HTTP ${res.status}`)
          return
        }
        const text = await res.text()
        if (!cancelled) setLogText(text)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    fetchLog()
    return () => {
      cancelled = true
    }
  }, [open, sessionId, sandboxId])

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose() }}>
      <DialogContent
        className="max-h-[80vh] max-w-3xl overflow-hidden"
        data-testid="sandbox-log-viewer"
      >
        <DialogHeader>
          <DialogTitle>{t('devStudio.test.logViewerTitle')}</DialogTitle>
          <DialogDescription className="sr-only">
            {t('devStudio.test.logViewerTitle')}
          </DialogDescription>
        </DialogHeader>
        <div className="overflow-auto">
          {loading && (
            <p className="text-muted-foreground text-sm" data-testid="sandbox-log-viewer:loading">
              {t('devStudio.preview.loading')}
            </p>
          )}
          {expired && (
            <p
              className="text-destructive text-sm"
              data-testid="sandbox-log-viewer:expired"
            >
              {t('devStudio.test.logExpired')}
            </p>
          )}
          {!loading && !expired && logText !== null && (
            <pre
              className="whitespace-pre-wrap break-words rounded bg-muted p-3 font-mono text-xs"
              data-testid="sandbox-log-viewer:content"
            >
              {logText}
            </pre>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
