'use client'

import { useState } from 'react'
import { Loader2, Plus, Trash2 } from 'lucide-react'
import useSWR from 'swr'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useTranslation } from '@/hooks/use-translation'
import { ApiKeyCreateDialog } from './api-key-create-dialog'
import type { ToolParameters } from './api-key-curl'

interface ApiKeyRow {
  id: string
  name: string
  keyPrefix: string
  active: boolean
  createdAt: string
  lastUsedAt: string | null
}

interface ApiKeysPayload {
  success: boolean
  keys: ApiKeyRow[]
}

const fetcher = (url: string) => fetch(url).then((r) => r.json())

interface ApiKeyManageDialogProps {
  open: boolean
  onClose: () => void
  instanceId: string
  /** Tool input JSON Schema — forwarded to the create dialog for its curl example. */
  parameters?: ToolParameters | null
}

/**
 * Management dialog for a published tool's API keys. Lists existing keys with
 * a masked prefix (the full secret is unrecoverable — only shown once at
 * creation), supports delete, and hosts the create-key entry point.
 *
 * Shares the SWR cache key with {@link ApiKeyPanel} so the panel's count badge
 * updates automatically on create/delete.
 */
export function ApiKeyManageDialog({
  open,
  onClose,
  instanceId,
  parameters,
}: ApiKeyManageDialogProps) {
  const { t } = useTranslation()
  const [createOpen, setCreateOpen] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const { data, mutate } = useSWR<ApiKeysPayload>(
    `/api/employee/skills/instances/${instanceId}/api-keys`,
    fetcher
  )
  const keys = data?.keys ?? []

  const handleDelete = async (keyId: string) => {
    setDeletingId(keyId)
    try {
      const res = await fetch(`/api/employee/skills/instances/${instanceId}/api-keys/${keyId}`, {
        method: 'DELETE',
      })
      if (res.ok) {
        await mutate()
      }
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className='sm:max-w-[560px]'>
        <DialogHeader>
          <DialogTitle className='flex items-center justify-between gap-2 pr-6'>
            <span>{t('skills.apiKey.manageTitle')}</span>
            <Button
              variant='outline'
              size='sm'
              onClick={() => setCreateOpen(true)}
              data-testid={`api-key-manage:button:create:${instanceId}`}
            >
              <Plus className='mr-1 h-3.5 w-3.5' />
              {t('skills.apiKey.create')}
            </Button>
          </DialogTitle>
        </DialogHeader>

        {keys.length > 0 ? (
          <div className='space-y-2'>
            {keys.map((k) => (
              <div
                key={k.id}
                className='flex items-center justify-between rounded-md border border-gray-200 bg-white px-3 py-2'
                data-testid={`api-key-manage:row:${k.id}`}
              >
                <div className='flex min-w-0 flex-col gap-0.5'>
                  <span className='truncate font-medium text-sm text-gray-800'>{k.name}</span>
                  <span className='font-mono text-xs text-gray-400'>{k.keyPrefix}••••••••</span>
                </div>
                <div className='flex shrink-0 items-center gap-3'>
                  <span className='text-xs text-gray-400'>
                    {k.lastUsedAt
                      ? `${t('skills.apiKey.lastUsed')}: ${new Date(k.lastUsedAt).toLocaleDateString()}`
                      : t('skills.apiKey.neverUsed')}
                  </span>
                  <button
                    type='button'
                    onClick={() => handleDelete(k.id)}
                    disabled={deletingId === k.id}
                    className='rounded p-1 text-red-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-50'
                    title={t('skills.apiKey.delete')}
                    data-testid={`api-key-manage:button:delete:${k.id}`}
                  >
                    {deletingId === k.id ? (
                      <Loader2 className='h-3.5 w-3.5 animate-spin' />
                    ) : (
                      <Trash2 className='h-3.5 w-3.5' />
                    )}
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className='py-6 text-center text-xs text-gray-400'>{t('skills.apiKeyEmpty')}</p>
        )}

        <ApiKeyCreateDialog
          open={createOpen}
          onClose={() => setCreateOpen(false)}
          instanceId={instanceId}
          parameters={parameters}
          onCreated={() => mutate()}
        />
      </DialogContent>
    </Dialog>
  )
}
