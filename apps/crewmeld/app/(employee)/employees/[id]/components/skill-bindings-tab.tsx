'use client'

import { useCallback, useEffect, useState } from 'react'
import { CheckCircle2, Layers, Link2Off, Loader2, Plus, Wrench } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/use-translation'

interface SkillBinding {
  bindingId: string
  skillId: string
  instanceId: string
  skillName: string
  instanceName: string
  skillDescription: string | null
  deployStatus: string
  endpoint: string | null
  createdAt: string
}

interface AvailableInstance {
  id: string
  templateId: string
  name: string
  templateName: string
  endpoint: string | null
}

interface SkillBindingsTabProps {
  employeeId: string
}

export function SkillBindingsTab({ employeeId }: SkillBindingsTabProps) {
  const { t } = useTranslation()
  const [bindings, setBindings] = useState<SkillBinding[]>([])
  const [availableInstances, setAvailableInstances] = useState<AvailableInstance[]>([])
  const [loading, setLoading] = useState(true)
  const [showAvailable, setShowAvailable] = useState(false)
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const fetchBindings = useCallback(async () => {
    try {
      const res = await fetch(`/api/employee/skills/bindings?employeeId=${employeeId}`)
      if (!res.ok) throw new Error(t('common.operationFailed'))
      const json = await res.json()
      setBindings(json.bindings ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : t('employees.loadFailed'))
    } finally {
      setLoading(false)
    }
  }, [employeeId])

  const fetchAvailable = useCallback(async () => {
    try {
      const res = await fetch('/api/employee/skills/bindable')
      if (!res.ok) return
      const json = await res.json()
      const items = (json.instances ?? []) as Array<{
        id: string
        templateId: string
        name: string
        templateName: string
        endpoint: string | null
      }>
      const boundInstanceIds = new Set(bindings.map((b) => b.instanceId))
      setAvailableInstances(
        items
          .filter((i) => !boundInstanceIds.has(i.id))
          .map((i) => ({
            id: i.id,
            templateId: i.templateId,
            name: i.name,
            templateName: i.templateName,
            endpoint: i.endpoint,
          }))
      )
    } catch {
      /* ignore */
    }
  }, [bindings])

  useEffect(() => {
    fetchBindings()
  }, [fetchBindings])

  useEffect(() => {
    if (showAvailable) {
      fetchAvailable()
    }
  }, [showAvailable, fetchAvailable])

  const handleBind = async (instanceId: string) => {
    setActionLoading(instanceId)
    setError(null)
    try {
      const res = await fetch('/api/employee/skills/bindings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ employeeId, instanceId }),
      })
      if (!res.ok) {
        const json = await res.json()
        throw new Error(json.error ?? t('common.operationFailed'))
      }
      await fetchBindings()
      setShowAvailable(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : t('common.operationFailed'))
    } finally {
      setActionLoading(null)
    }
  }

  const handleUnbind = async (bindingId: string) => {
    setActionLoading(bindingId)
    setError(null)
    try {
      const res = await fetch('/api/employee/skills/bindings', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: bindingId }),
      })
      if (!res.ok) {
        const json = await res.json()
        throw new Error(json.error ?? t('common.operationFailed'))
      }
      await fetchBindings()
    } catch (e) {
      setError(e instanceof Error ? e.message : t('common.operationFailed'))
    } finally {
      setActionLoading(null)
    }
  }

  if (loading) {
    return (
      <div className='space-y-4'>
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className='h-16 animate-pulse rounded-lg bg-gray-200' />
        ))}
      </div>
    )
  }

  return (
    <div className='space-y-6' data-testid='skill-bindings:container'>
      {error && (
        <div className='rounded-lg border border-red-200 bg-red-50 p-3 text-red-600 text-sm'>
          {error}
        </div>
      )}

      <div className='flex items-center justify-between'>
        <h3 className='font-semibold text-gray-900 text-sm'>
          {t('employees.boundInstances', { count: bindings.length })}
        </h3>
        <Button
          variant='outline'
          size='sm'
          data-testid='skill-bindings:add-btn'
          onClick={() => setShowAvailable(!showAvailable)}
        >
          <Plus className='h-3.5 w-3.5' />
          {t('employees.skillBind')}
        </Button>
      </div>

      {bindings.length === 0 ? (
        <div className='rounded-lg border-2 border-gray-200 border-dashed py-8 text-center'>
          <Wrench className='mx-auto h-8 w-8 text-gray-300' />
          <p className='mt-2 text-gray-500 text-sm'>{t('employees.skillEmpty')}</p>
          <p className='mt-1 text-gray-400 text-xs'>{t('employees.skillEmptyHint')}</p>
        </div>
      ) : (
        <div className='space-y-2'>
          {bindings.map((binding) => (
            <div
              key={binding.bindingId}
              data-testid={`skill-bindings:item:${binding.instanceId}`}
              className='flex items-center justify-between rounded-lg border border-gray-200 bg-white px-4 py-3'
            >
              <div className='flex items-center gap-3'>
                <Layers className='h-5 w-5 text-purple-500' />
                <div>
                  <p className='font-medium text-gray-900 text-sm'>{binding.instanceName}</p>
                  <div className='flex items-center gap-2 text-gray-500 text-xs'>
                    <span className='text-gray-400'>
                      {t('employees.sourceTemplate')}:{binding.skillName}
                    </span>
                    <span>·</span>
                    <span className='flex items-center gap-1 text-green-600'>
                      <CheckCircle2 className='h-3 w-3' />
                      {t('dashboard.deployed')}
                    </span>
                    {binding.endpoint && (
                      <>
                        <span>·</span>
                        <span className='font-mono text-gray-400'>{binding.endpoint}</span>
                      </>
                    )}
                  </div>
                </div>
              </div>
              <Button
                variant='outline'
                size='sm'
                data-testid={`skill-bindings:unbind:${binding.instanceId}`}
                disabled={actionLoading === binding.bindingId}
                onClick={() => handleUnbind(binding.bindingId)}
              >
                {actionLoading === binding.bindingId ? (
                  <Loader2 className='h-3.5 w-3.5 animate-spin' />
                ) : (
                  <Link2Off className='h-3.5 w-3.5' />
                )}
                {t('employees.skillUnbind')}
              </Button>
            </div>
          ))}
        </div>
      )}

      {showAvailable && (
        <div>
          <h3 className='mb-3 font-semibold text-gray-900 text-sm'>
            {t('employees.availableInstances', { count: availableInstances.length })}
          </h3>
          {availableInstances.length === 0 ? (
            <div className='rounded-lg border-2 border-gray-200 border-dashed py-6 text-center'>
              <p className='text-gray-500 text-sm'>{t('employees.skillNoAvailable')}</p>
              <p className='mt-1 text-gray-400 text-xs'>{t('employees.skillAllBound')}</p>
            </div>
          ) : (
            <div className='space-y-2'>
              {availableInstances.map((inst) => (
                <div
                  key={inst.id}
                  data-testid={`skill-bindings:available:${inst.id}`}
                  className='flex items-center justify-between rounded-lg border border-gray-200 bg-white px-4 py-3'
                >
                  <div className='flex items-center gap-3'>
                    <Layers className='h-5 w-5 text-gray-400' />
                    <div>
                      <p className='font-medium text-gray-900 text-sm'>{inst.name}</p>
                      <p className='text-gray-400 text-xs'>
                        {t('employees.sourceTemplate')}:{inst.templateName}
                      </p>
                    </div>
                  </div>
                  <Button
                    variant='default'
                    size='sm'
                    data-testid={`skill-bindings:bind:${inst.id}`}
                    disabled={actionLoading === inst.id}
                    onClick={() => handleBind(inst.id)}
                  >
                    {actionLoading === inst.id ? (
                      <Loader2 className='h-3.5 w-3.5 animate-spin' />
                    ) : (
                      <Plus className='h-3.5 w-3.5' />
                    )}
                    {t('employees.skillBind')}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
