'use client'

import { useState } from 'react'
import { Copy, KeyRound, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { copyToClipboard } from '@/lib/core/utils/clipboard'
import { useTranslation } from '@/hooks/use-translation'
import { buildCurlExample, type ToolParameters } from './api-key-curl'

interface ApiKeyCreateDialogProps {
  open: boolean
  onClose: () => void
  instanceId: string
  /** Tool input JSON Schema — used to render a ready-to-run curl with the new key. */
  parameters?: ToolParameters | null
  /** Called after a key is successfully created so the parent can refresh its list */
  onCreated?: () => void
}

/**
 * Dialog for creating a new API key for a tool instance.
 *
 * After creation the plaintext key is shown exactly once with a copy button,
 * followed by a ready-to-run curl example with the new key pre-filled into the
 * `X-API-Key` header — the one moment the full key exists client-side.
 */
export function ApiKeyCreateDialog({
  open,
  onClose,
  instanceId,
  parameters,
  onCreated,
}: ApiKeyCreateDialogProps) {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [creating, setCreating] = useState(false)
  /** Non-null when key has been created — shown only once */
  const [plaintextKey, setPlaintextKey] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [curlCopied, setCurlCopied] = useState(false)

  const handleCreate = async () => {
    if (!name.trim() || creating) return
    setCreating(true)
    try {
      const res = await fetch(`/api/employee/skills/instances/${instanceId}/api-keys`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
      })
      if (!res.ok) return
      const data = await res.json()
      setPlaintextKey(data.key)
      onCreated?.()
    } finally {
      setCreating(false)
    }
  }

  const handleClose = () => {
    setName('')
    setPlaintextKey(null)
    setCopied(false)
    setCurlCopied(false)
    onClose()
  }

  const handleCopy = async () => {
    if (!plaintextKey) return
    await copyToClipboard(plaintextKey)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const endpoint = `${typeof window !== 'undefined' ? window.location.origin : ''}/api/tools/${instanceId}/invoke`
  const curlExample = plaintextKey
    ? buildCurlExample({ endpoint, parameters, apiKey: plaintextKey })
    : ''

  const handleCopyCurl = async () => {
    if (!curlExample) return
    await copyToClipboard(curlExample)
    setCurlCopied(true)
    setTimeout(() => setCurlCopied(false), 2000)
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && handleClose()}>
      <DialogContent className='sm:max-w-[460px]'>
        <DialogHeader>
          <DialogTitle className='flex items-center gap-2'>
            <KeyRound className='h-5 w-5 text-violet-600' />
            {plaintextKey ? t('skills.apiKey.createdTitle') : t('skills.apiKey.create')}
          </DialogTitle>
          {plaintextKey && <DialogDescription>{t('skills.apiKey.createdBody')}</DialogDescription>}
        </DialogHeader>

        {plaintextKey ? (
          <div className='min-w-0 space-y-3'>
            <div className='flex min-w-0 items-center gap-2 rounded-lg border border-green-200 bg-green-50 p-3'>
              <code className='flex-1 break-all font-mono text-xs text-green-800'>
                {plaintextKey}
              </code>
              <Button
                variant='ghost'
                size='sm'
                onClick={handleCopy}
                data-testid='api-key-create:button:copy'
              >
                <Copy className='mr-1 h-3.5 w-3.5' />
                {copied ? '✓' : t('skills.apiKey.copy')}
              </Button>
            </div>

            {/* Ready-to-run curl with the new key pre-filled */}
            <div className='min-w-0 space-y-1'>
              <div className='flex items-center justify-between'>
                <span className='text-xs text-gray-500'>{t('skills.apiKey.curlReady')}</span>
                <Button
                  variant='ghost'
                  size='sm'
                  onClick={handleCopyCurl}
                  data-testid='api-key-create:button:copy-curl'
                >
                  <Copy className='mr-1 h-3.5 w-3.5' />
                  {curlCopied ? '✓' : t('skills.apiKey.copy')}
                </Button>
              </div>
              <pre className='min-w-0 max-w-full overflow-x-auto rounded bg-gray-100 p-2 font-mono text-xs text-gray-700'>
                {curlExample}
              </pre>
            </div>
          </div>
        ) : (
          <div className='min-w-0 space-y-3'>
            <Input
              placeholder={t('skills.apiKey.namePlaceholder')}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
              data-testid='api-key-create:input:name'
            />
          </div>
        )}

        <DialogFooter>
          {plaintextKey ? (
            <Button onClick={handleClose} data-testid='api-key-create:button:done'>
              {t('common.confirm')}
            </Button>
          ) : (
            <Button
              onClick={handleCreate}
              disabled={creating || !name.trim()}
              className='bg-violet-600 hover:bg-violet-700'
              data-testid='api-key-create:button:create'
            >
              {creating && <Loader2 className='mr-2 h-4 w-4 animate-spin' />}
              {t('skills.apiKey.create')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
