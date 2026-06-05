'use client'

import { useState } from 'react'
import { Copy, KeyRound, Settings } from 'lucide-react'
import useSWR from 'swr'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { copyToClipboard } from '@/lib/core/utils/clipboard'
import { useTranslation } from '@/hooks/use-translation'
import { buildCurlExample, type ToolParameters } from './api-key-curl'
import { ApiKeyManageDialog } from './api-key-manage-dialog'

interface ApiKeysPayload {
  success: boolean
  keys: { id: string }[]
}

const fetcher = (url: string) => fetch(url).then((r) => r.json())

interface ApiKeyPanelProps {
  instanceId: string
  /** Tool input JSON Schema (template.parameters). Used to render a realistic curl example. */
  parameters?: ToolParameters | null
}

/**
 * Panel for a published tool instance: a "Manage" entry (with a key-count
 * badge) that opens the key management dialog, plus inline API usage docs.
 *
 * The key list itself lives in {@link ApiKeyManageDialog} (a wider overlay) so
 * the narrow side panel no longer wraps key rows.
 */
export function ApiKeyPanel({ instanceId, parameters }: ApiKeyPanelProps) {
  const { t } = useTranslation()
  const [manageOpen, setManageOpen] = useState(false)

  const { data } = useSWR<ApiKeysPayload>(
    `/api/employee/skills/instances/${instanceId}/api-keys`,
    fetcher
  )
  const count = data?.keys?.length ?? 0

  /** Endpoint URL for this instance */
  const endpoint = `${typeof window !== 'undefined' ? window.location.origin : ''}/api/tools/${instanceId}/invoke`

  const curlExample = `${buildCurlExample({ endpoint, parameters, apiKey: 'YOUR_API_KEY' })}

# ${t('skills.apiDoc.responseExample')}:
# {"success": true, "result": {...}, "executionTime": 123}`

  return (
    <div className='mt-4 rounded-lg border border-violet-100 bg-violet-50/30 p-4'>
      {/* Header */}
      <div className='mb-3 flex items-center justify-between'>
        <div className='flex items-center gap-2'>
          <KeyRound className='h-4 w-4 text-violet-600' />
          <span className='font-medium text-sm text-gray-700'>API Keys</span>
        </div>
        <div className='relative'>
          <Button
            variant='outline'
            size='sm'
            onClick={() => setManageOpen(true)}
            data-testid={`api-key-panel:button:manage:${instanceId}`}
          >
            <Settings className='mr-1 h-3.5 w-3.5' />
            {t('skills.apiKey.manage')}
          </Button>
          {count > 0 && (
            <Badge
              className='-top-2 -right-2 absolute h-5 min-w-5 justify-center px-1 text-[10px]'
              data-testid={`api-key-panel:badge:count:${instanceId}`}
            >
              {count}
            </Badge>
          )}
        </div>
      </div>

      {/* API documentation */}
      <div className='space-y-2 rounded-md border border-gray-200 bg-white p-3'>
        <h4 className='font-medium text-xs text-gray-600'>{t('skills.apiDoc.title')}</h4>
        <div>
          <span className='text-xs text-gray-500'>{t('skills.apiDoc.endpoint')}:</span>
          <div className='mt-1 flex items-center gap-1.5'>
            <code className='flex-1 truncate rounded bg-gray-100 px-2 py-1 font-mono text-xs text-gray-700'>
              {endpoint}
            </code>
            <button
              type='button'
              onClick={() => copyToClipboard(endpoint)}
              className='shrink-0 rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600'
            >
              <Copy className='h-3.5 w-3.5' />
            </button>
          </div>
        </div>
        <div>
          <span className='text-xs text-gray-500'>{t('skills.apiDoc.example')}:</span>
          <pre className='mt-1 overflow-x-auto rounded bg-gray-100 p-2 font-mono text-xs text-gray-700'>
            {curlExample}
          </pre>
        </div>
      </div>

      {/* Management dialog (hosts the key list + create) */}
      <ApiKeyManageDialog
        open={manageOpen}
        onClose={() => setManageOpen(false)}
        instanceId={instanceId}
        parameters={parameters}
      />
    </div>
  )
}
