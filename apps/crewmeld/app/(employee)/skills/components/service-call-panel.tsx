'use client'

import { useState } from 'react'
import { Copy, ExternalLink, Globe2, KeyRound, Settings } from 'lucide-react'
import useSWR from 'swr'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { copyToClipboard } from '@/lib/core/utils/clipboard'
import { useTranslation } from '@/hooks/use-translation'
import type { SkillPackage, ToolInstance } from '../types'
import type { ToolParameters } from './api-key-curl'
import { ApiKeyManageDialog } from './api-key-manage-dialog'
import { buildServiceCallDocs } from './service-call-docs'

interface ApiKeysPayload {
  success: boolean
  keys: { id: string }[]
}

interface ServicePayload {
  service?: Partial<ToolInstance>
  sharedPublicUrl?: string
}

interface ServiceCallPanelProps {
  instance: ToolInstance
  template: SkillPackage
  parameters?: ToolParameters | null
}

const fetcher = (url: string) => fetch(url).then((response) => response.json())

/** Published service documentation with optional API key management. */
export function ServiceCallPanel({ instance, template, parameters }: ServiceCallPanelProps) {
  const { t } = useTranslation()
  const [manageOpen, setManageOpen] = useState(false)
  const { data: servicePayload } = useSWR<ServicePayload>(
    `/api/employee/skills/instances/${instance.id}/service`,
    fetcher
  )
  const service = servicePayload?.service
  const authMode = service?.serviceAuthMode ?? instance.serviceAuthMode ?? 'api-key'
  const visibility = service?.serviceVisibility ?? instance.serviceVisibility ?? 'internal'
  const { data: keysPayload } = useSWR<ApiKeysPayload>(
    authMode === 'api-key' ? `/api/employee/skills/instances/${instance.id}/api-keys` : null,
    fetcher
  )
  const count = keysPayload?.keys?.length ?? 0
  const serviceSpec = template.serviceSpec
  const docs = buildServiceCallDocs({
    instanceId: instance.id,
    serviceType: serviceSpec?.type ?? 'json',
    method: serviceSpec?.method ?? 'POST',
    authMode,
    visibility,
    currentOrigin: typeof window === 'undefined' ? '' : window.location.origin,
    customDomain: service?.serviceDomain ?? instance.serviceDomain,
    sharedPublicUrl: servicePayload?.sharedPublicUrl,
    parameters,
  })

  return (
    <div className='mt-4 rounded-lg border border-violet-100 bg-violet-50/30 p-4'>
      <div className='mb-3 flex items-center justify-between gap-2'>
        <div className='flex items-center gap-2'>
          {authMode === 'api-key' ? (
            <KeyRound className='h-4 w-4 text-violet-600' />
          ) : (
            <Globe2 className='h-4 w-4 text-violet-600' />
          )}
          <span className='font-medium text-gray-700 text-sm'>{t('skills.apiDoc.title')}</span>
          <Badge variant='outline'>
            {authMode === 'api-key'
              ? t('skills.apiDoc.apiKeyAccess')
              : t('skills.apiDoc.anonymousAccess')}
          </Badge>
        </div>
        {authMode === 'api-key' && (
          <div className='relative'>
            <Button
              variant='outline'
              size='sm'
              onClick={() => setManageOpen(true)}
              data-testid={`service-call:button:manage:${instance.id}`}
            >
              <Settings className='mr-1 h-3.5 w-3.5' />
              {t('skills.apiKey.manage')}
            </Button>
            {count > 0 && (
              <Badge
                className='-top-2 -right-2 absolute h-5 min-w-5 justify-center px-1 text-[10px]'
                data-testid={`service-call:badge:count:${instance.id}`}
              >
                {count}
              </Badge>
            )}
          </div>
        )}
      </div>

      <div className='space-y-3 rounded-md border border-gray-200 bg-white p-3'>
        <div className='flex items-center gap-2 text-gray-500 text-xs'>
          <Badge variant='secondary'>{docs.method}</Badge>
          <span>{serviceSpec?.type.toUpperCase() ?? 'JSON'}</span>
        </div>
        <div>
          <span className='text-gray-500 text-xs'>{t('skills.apiDoc.endpoint')}:</span>
          <div className='mt-1 flex items-center gap-1.5'>
            <code className='flex-1 break-all rounded bg-gray-100 px-2 py-1 font-mono text-gray-700 text-xs'>
              {docs.endpoint}
            </code>
            <button
              type='button'
              onClick={() => copyToClipboard(docs.endpoint)}
              className='shrink-0 rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600'
              aria-label={t('skills.apiDoc.copyEndpoint')}
            >
              <Copy className='h-3.5 w-3.5' />
            </button>
          </div>
        </div>

        {docs.browserUrl && (
          <a
            href={docs.browserUrl}
            target='_blank'
            rel='noreferrer'
            className='inline-flex items-center gap-1 text-violet-600 text-xs hover:underline'
            data-testid={`service-call:link:browser:${instance.id}`}
          >
            <ExternalLink className='h-3.5 w-3.5' />
            {t('skills.apiDoc.openBrowser')}
          </a>
        )}

        <div>
          <span className='text-gray-500 text-xs'>{t('skills.apiDoc.example')}:</span>
          <pre className='mt-1 overflow-x-auto whitespace-pre-wrap rounded bg-gray-100 p-2 font-mono text-gray-700 text-xs'>
            {docs.curl}
          </pre>
        </div>
      </div>

      {authMode === 'api-key' && (
        <ApiKeyManageDialog
          open={manageOpen}
          onClose={() => setManageOpen(false)}
          instanceId={instance.id}
          parameters={parameters}
        />
      )}
    </div>
  )
}
