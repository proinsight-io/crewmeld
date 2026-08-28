'use client'

import { useEffect, useState } from 'react'
import { Copy, ExternalLink, Globe2, Loader2, Server } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { copyToClipboard } from '@/lib/core/utils/clipboard'
import { buildServiceAccessUrl } from '@/lib/tools/service-access-url'
import { useTranslation } from '@/hooks/use-translation'
import type { SkillPackage, ToolInstance } from '../types'

interface ServicePublishSettingsProps {
  instance: ToolInstance
  template: SkillPackage
  onChanged: (instance: ToolInstance) => void
}

interface ServicePayload {
  service?: ToolInstance
  sharedPublicUrl?: string
  detail?: string
}

/** Publication, authentication, domain, and replica controls for one service. */
export function ServicePublishSettings({
  instance,
  template,
  onChanged,
}: ServicePublishSettingsProps) {
  const { t } = useTranslation()
  const [authMode, setAuthMode] = useState(instance.serviceAuthMode ?? 'api-key')
  const [visibility, setVisibility] = useState(instance.serviceVisibility ?? 'internal')
  const [customDomain, setCustomDomain] = useState(instance.serviceDomain ?? '')
  const [desiredReplicas, setDesiredReplicas] = useState(instance.desiredReplicas ?? 1)
  const [replicas, setReplicas] = useState(instance.replicas ?? [])
  const [sharedPublicUrl, setSharedPublicUrl] = useState<string | undefined>()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    fetch(`/api/employee/skills/instances/${instance.id}/service`)
      .then(async (response) => {
        if (!response.ok) return null
        return (await response.json()) as ServicePayload
      })
      .then((payload) => {
        if (!active || !payload?.service) return
        const service = payload.service
        setAuthMode(service.serviceAuthMode ?? 'api-key')
        setVisibility(service.serviceVisibility ?? 'internal')
        setCustomDomain(service.serviceDomain ?? '')
        setDesiredReplicas(service.desiredReplicas ?? 1)
        setReplicas(service.replicas ?? [])
        setSharedPublicUrl(payload.sharedPublicUrl)
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [instance.id])

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      const response = await fetch(`/api/employee/skills/instances/${instance.id}/service`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          authMode,
          visibility,
          customDomain: visibility === 'public' ? customDomain : null,
          desiredReplicas: template.kind === 'service' ? desiredReplicas : 1,
        }),
      })
      const payload = (await response.json()) as ServicePayload
      if (!response.ok) throw new Error(payload.detail ?? '保存服务配置失败')

      let next: ToolInstance = {
        ...instance,
        serviceAuthMode: authMode,
        serviceVisibility: visibility,
        serviceDomain: visibility === 'public' ? customDomain : null,
        desiredReplicas: template.kind === 'service' ? desiredReplicas : 1,
      }

      if (template.kind === 'service' && instance.deploy?.status === 'deployed') {
        const deployResponse = await fetch(`/api/employee/skills/instances/${instance.id}/deploy`, {
          method: 'POST',
        })
        const deployPayload = (await deployResponse.json()) as {
          deploy?: ToolInstance['deploy']
          detail?: string
        }
        if (!deployResponse.ok) throw new Error(deployPayload.detail ?? '服务扩缩容失败')
        next = { ...next, deploy: deployPayload.deploy }
        const refreshed = await fetch(`/api/employee/skills/instances/${instance.id}/service`)
        if (refreshed.ok) {
          const refreshedPayload = (await refreshed.json()) as ServicePayload
          setReplicas(refreshedPayload.service?.replicas ?? [])
        }
      }
      onChanged(next)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存服务配置失败')
    } finally {
      setSaving(false)
    }
  }

  const hasPublicUrl =
    visibility !== 'public' || Boolean(customDomain.trim() || sharedPublicUrl?.trim())
  const displayedUrl = hasPublicUrl
    ? buildServiceAccessUrl({
        instanceId: instance.id,
        visibility,
        internalBaseUrl: typeof window === 'undefined' ? '' : window.location.origin,
        customDomain,
        sharedPublicUrl,
      })
    : null

  return (
    <div className='mb-3 space-y-3 rounded-lg border border-cyan-100 bg-cyan-50/40 p-3'>
      <div className='grid gap-3 sm:grid-cols-2'>
        <label className='space-y-1 text-gray-600 text-xs'>
          <span>访问认证</span>
          <select
            value={authMode}
            onChange={(event) => setAuthMode(event.target.value as 'api-key' | 'anonymous')}
            className='w-full rounded-md border border-gray-200 bg-white px-2 py-1.5 text-sm'
            data-testid={`service-settings:select:auth:${instance.id}`}
          >
            <option value='api-key'>API Key</option>
            <option value='anonymous'>匿名访问</option>
          </select>
        </label>
        <label className='space-y-1 text-gray-600 text-xs'>
          <span>网络范围</span>
          <select
            value={visibility}
            onChange={(event) => setVisibility(event.target.value as 'internal' | 'public')}
            className='w-full rounded-md border border-gray-200 bg-white px-2 py-1.5 text-sm'
            data-testid={`service-settings:select:visibility:${instance.id}`}
          >
            <option value='internal'>内网</option>
            <option value='public'>公网域名</option>
          </select>
        </label>
      </div>

      {visibility === 'public' && (
        <label className='block space-y-1 text-gray-600 text-xs'>
          <span>独立公网域名（可选）</span>
          <input
            value={customDomain}
            onChange={(event) => setCustomDomain(event.target.value)}
            placeholder='service.example.com'
            className='w-full rounded-md border border-gray-200 bg-white px-2 py-1.5 text-sm'
            data-testid={`service-settings:input:domain:${instance.id}`}
          />
          <span className='block text-gray-400'>留空时使用平台统一公网服务前缀</span>
        </label>
      )}

      {template.kind === 'service' && (
        <label className='block space-y-1 text-gray-600 text-xs'>
          <span>实例数量（1–20）</span>
          <input
            type='number'
            min={1}
            max={20}
            value={desiredReplicas}
            onChange={(event) => setDesiredReplicas(Number(event.target.value))}
            className='w-28 rounded-md border border-gray-200 bg-white px-2 py-1.5 text-sm'
            data-testid={`service-settings:input:replicas:${instance.id}`}
          />
        </label>
      )}

      <div className='space-y-1 text-gray-500 text-xs'>
        <div className='flex items-start gap-1.5'>
          <Server className='mt-0.5 h-3.5 w-3.5 shrink-0' />
          <div className='min-w-0 flex-1 space-y-1'>
            <span className='block'>{t('skills.serviceAddress')}</span>
            {displayedUrl ? (
              <div className='flex items-start gap-1.5'>
                <a
                  href={displayedUrl}
                  target='_blank'
                  rel='noreferrer'
                  className='min-w-0 flex-1 break-all font-mono text-cyan-700 hover:underline'
                  data-testid={`service-settings:link:address:${instance.id}`}
                >
                  {displayedUrl}
                  <ExternalLink className='ml-1 inline h-3 w-3' />
                </a>
                <button
                  type='button'
                  onClick={() => copyToClipboard(displayedUrl)}
                  className='shrink-0 rounded p-1 text-gray-400 hover:bg-cyan-100 hover:text-gray-600'
                  aria-label={t('skills.apiDoc.copyEndpoint')}
                  data-testid={`service-settings:button:copy-address:${instance.id}`}
                >
                  <Copy className='h-3.5 w-3.5' />
                </button>
              </div>
            ) : (
              <span className='block text-amber-600'>{t('skills.publicServiceUrlMissing')}</span>
            )}
          </div>
        </div>
        {template.serviceSpec && (
          <div className='flex items-center gap-1.5'>
            <Globe2 className='h-3.5 w-3.5' />
            <span>服务类型：{template.serviceSpec.type.toUpperCase()}</span>
          </div>
        )}
      </div>

      {replicas.length > 0 && (
        <div
          className='flex flex-wrap gap-1.5'
          data-testid={`service-settings:replicas:${instance.id}`}
        >
          {replicas.map((replica) => (
            <span
              key={replica.id}
              className={`rounded-full px-2 py-0.5 text-xs ${
                replica.status === 'ready'
                  ? 'bg-green-100 text-green-700'
                  : replica.status === 'failed'
                    ? 'bg-red-100 text-red-700'
                    : 'bg-gray-100 text-gray-600'
              }`}
              title={replica.errorMessage ?? undefined}
            >
              {replica.name} · {replica.status}
            </span>
          ))}
        </div>
      )}

      {error && <p className='text-red-600 text-xs'>{error}</p>}
      <div className='flex justify-end'>
        <Button
          size='sm'
          variant='outline'
          onClick={save}
          disabled={saving}
          data-testid={`service-settings:button:save:${instance.id}`}
        >
          {saving && <Loader2 className='mr-1 h-3.5 w-3.5 animate-spin' />}
          保存服务配置
        </Button>
      </div>
    </div>
  )
}
