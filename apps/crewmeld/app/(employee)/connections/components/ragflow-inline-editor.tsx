'use client'

import { useCallback, useEffect, useState } from 'react'
import { CheckCircle2, Info, Loader2, RefreshCw, Trash2, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { ConnectionCardData, ConnectionStatus } from '@/lib/connectors/types'
import { CONNECTION_CONFIG_FIELDS } from '@/lib/connectors/types'
import { cn } from '@/lib/core/utils/cn'
import { renderHealthMessage } from '@/lib/i18n/render-health-message'
import { useTranslation } from '@/hooks/use-translation'

interface RagflowInlineEditorProps {
  /** Current ragflow connection (null = not yet created) */
  connection: ConnectionCardData | null
  loading: boolean
  canEdit: boolean
  canCreate: boolean
  canDelete: boolean
  onRefetch: () => void
}

const RAGFLOW_FIELDS = CONNECTION_CONFIG_FIELDS.ragflow

export function RagflowInlineEditor({
  connection,
  loading,
  canEdit,
  canCreate,
  canDelete,
  onRefetch,
}: RagflowInlineEditorProps) {
  const { t, tMessage } = useTranslation()

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [config, setConfig] = useState<Record<string, string | number | boolean>>({})
  const [configuredPasswordKeys, setConfiguredPasswordKeys] = useState<Set<string>>(new Set())

  const [isSaving, setIsSaving] = useState(false)
  const [isTesting, setIsTesting] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [successMsg, setSuccessMsg] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<{
    success: boolean
    messageKey: string
    messageParams?: Record<string, string>
    latencyMs: number
  } | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState(false)

  // Sync form when connection data changes
  useEffect(() => {
    if (connection) {
      setName(connection.name)
      setDescription(connection.description ?? '')
      const cfg: Record<string, string | number | boolean> = {}
      const pwdConfigured = new Set<string>()
      const pwdKeys = new Set(RAGFLOW_FIELDS.filter((f) => f.type === 'password').map((f) => f.key))
      for (const [k, v] of Object.entries(connection.config)) {
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
          if (pwdKeys.has(k) && typeof v === 'string' && v.includes('****')) {
            pwdConfigured.add(k)
            // Keep masked value for display, user clears and re-enters when editing
            cfg[k] = v
          } else {
            cfg[k] = v
          }
        }
      }
      setConfiguredPasswordKeys(pwdConfigured)
      setConfig(cfg)
    } else {
      setName('')
      setDescription('')
      setConfig({})
      setConfiguredPasswordKeys(new Set())
    }
    setError(null)
    setSuccessMsg(null)
    setTestResult(null)
    // Depend on connection?.id only: re-sync form when switching entity, not on
    // every refetch — refetch must not wipe in-progress edits or testResult.
  }, [connection?.id])

  const handleTestConnection = useCallback(async () => {
    setIsTesting(true)
    setTestResult(null)
    setError(null)
    try {
      // Saved connections use [id]/test endpoint, passing form config
      // Server replaces masked fields (with ****) with real DB values, uses user input for rest
      // New connections use no-ID endpoint, testing with plaintext form config
      const url = connection
        ? `/api/employee/connectors/${connection.id}/test`
        : '/api/employee/connectors/test'
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'ragflow', config }),
      })
      const json = await res.json()
      if (json.success) {
        setTestResult(json.data)
      } else {
        setError(json.error ?? t('connections.wizardTestFailed'))
      }
      // Server updates connection.status in DB regardless of test outcome,
      // so refetch in both branches to sync the upper status badge.
      if (connection) onRefetch()
    } catch {
      setError(t('common.networkError'))
    } finally {
      setIsTesting(false)
    }
  }, [connection, config, t, onRefetch])

  const handleSave = useCallback(async () => {
    if (!name.trim()) return
    setIsSaving(true)
    setError(null)
    setSuccessMsg(null)
    try {
      if (connection) {
        // Edit mode
        const payload: Record<string, unknown> = {
          name: name.trim(),
          description: description.trim() || undefined,
        }
        const cleanConfig: Record<string, unknown> = {}
        let hasConfigChanges = false
        for (const [k, v] of Object.entries(config)) {
          if (typeof v === 'string' && v.includes('****')) continue
          if (configuredPasswordKeys.has(k) && v === '') continue
          cleanConfig[k] = v
          hasConfigChanges = true
        }
        if (hasConfigChanges) {
          payload.config = cleanConfig
        }
        const res = await fetch(`/api/employee/connectors/${connection.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
        const json = await res.json()
        if (json.success) {
          setSuccessMsg(t('common.saveSuccess'))
          // Auto health check after save
          fetch(`/api/employee/connectors/${connection.id}/health-check`, { method: 'POST' }).catch(
            () => {}
          )
          onRefetch()
        } else {
          setError(tMessage(json) || t('connections.wizardUpdateFailed'))
        }
      } else {
        // Create mode
        const res = await fetch('/api/employee/connectors', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: name.trim(),
            type: 'ragflow',
            description: description.trim() || undefined,
            config,
          }),
        })
        const json = await res.json()
        if (json.success) {
          setSuccessMsg(t('common.saveSuccess'))
          const connId = json.data?.id
          if (connId) {
            fetch(`/api/employee/connectors/${connId}/health-check`, { method: 'POST' }).catch(
              () => {}
            )
          }
          onRefetch()
        } else {
          setError(tMessage(json) || t('connections.wizardSaveFailed'))
        }
      }
    } catch {
      setError(t('common.networkError'))
    } finally {
      setIsSaving(false)
    }
  }, [connection, name, description, config, configuredPasswordKeys, onRefetch, t, tMessage])

  const handleDelete = useCallback(async () => {
    if (!connection) return
    setIsDeleting(true)
    try {
      await fetch(`/api/employee/connectors/${connection.id}`, { method: 'DELETE' })
      onRefetch()
    } finally {
      setIsDeleting(false)
      setDeleteConfirm(false)
    }
  }, [connection, onRefetch])

  const STATUS_LABELS: Record<ConnectionStatus, string> = {
    connected: t('connections.statusConnected'),
    disconnected: t('connections.statusDisconnected'),
    error: t('connections.statusError'),
    testing: t('connections.statusTesting'),
  }

  const canSave = connection ? canEdit : canCreate
  const hasRequiredFields =
    name.trim().length > 0 &&
    RAGFLOW_FIELDS.filter((f) => f.required).every((f) => {
      const val = config[f.key]
      if (configuredPasswordKeys.has(f.key)) return true
      return typeof val === 'string' ? val.trim().length > 0 : val !== undefined && val !== null
    })

  if (loading) {
    return (
      <div>
        <div className='h-64 animate-pulse rounded-lg border border-gray-200 bg-gray-100' />
      </div>
    )
  }

  return (
    <div>
      <div className='space-y-6'>
        {/* Top tip */}
        <div className='flex items-center gap-2 rounded-lg border border-blue-100 bg-blue-50/60 px-3 py-2 text-blue-700 text-xs'>
          <Info className='h-3.5 w-3.5 shrink-0' />
          <span>{t('connections.ragflowOnlyTip')}</span>
        </div>

        {/* Connection status info（edit mode only） */}
        {connection && (
          <div className='mb-6 flex items-center justify-between rounded-lg bg-gray-50 px-4 py-3'>
            <div className='flex items-center gap-3'>
              <span className='text-2xl'>📚</span>
              <div>
                <div className='flex items-center gap-2'>
                  <span
                    className={cn(
                      'inline-block h-2.5 w-2.5 rounded-full',
                      connection.status === 'connected' && 'bg-green-500',
                      connection.status === 'error' && 'bg-red-500',
                      connection.status === 'testing' && 'animate-pulse bg-yellow-500',
                      connection.status === 'disconnected' && 'bg-gray-400'
                    )}
                  />
                  <span className='font-medium text-gray-700 text-sm'>
                    {STATUS_LABELS[connection.status] ?? connection.status}
                  </span>
                </div>
                {connection.lastHealthCheck && (
                  <span className='text-gray-400 text-xs'>
                    {t('connections.lastCheck', {
                      date: new Date(connection.lastHealthCheck).toLocaleString(),
                    })}
                  </span>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Error message（connection status error） */}
        {connection?.status === 'error' &&
          renderHealthMessage(connection?.lastHealthMessageI18n, t) && (
            <div className='mb-4 rounded-lg bg-red-50 px-3 py-2 text-red-600 text-xs'>
              {renderHealthMessage(connection?.lastHealthMessageI18n, t)}
            </div>
          )}

        {/* Info messages */}
        {error && (
          <div className='mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-red-600 text-sm'>
            {error}
          </div>
        )}
        {successMsg && (
          <div className='mb-4 rounded-lg border border-green-200 bg-green-50 p-3 text-green-600 text-sm'>
            {successMsg}
          </div>
        )}

        {/* Form */}
        <div className='space-y-4'>
          {/* Name + description */}
          <div className='grid grid-cols-2 gap-4'>
            <div>
              <label
                htmlFor='ragflow-inline-name'
                className='mb-1 block font-medium text-gray-700 text-sm'
              >
                {t('connections.wizardConnectionName')} <span className='text-red-500'>*</span>
              </label>
              <Input
                id='ragflow-inline-name'
                data-testid='ragflow-inline:input:name'
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('connections.wizardExamplePrefix') + t('connections.typeRagflow')}
                maxLength={100}
                disabled={!canSave}
              />
            </div>
            <div>
              <label
                htmlFor='ragflow-inline-description'
                className='mb-1 block font-medium text-gray-700 text-sm'
              >
                {t('common.description')}
              </label>
              <Input
                id='ragflow-inline-description'
                data-testid='ragflow-inline:input:description'
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={t('connections.wizardOptional')}
                maxLength={500}
                disabled={!canSave}
              />
            </div>
          </div>

          {/* Ragflow config fields */}
          {RAGFLOW_FIELDS.map((field) => {
            const isConfiguredPwd = configuredPasswordKeys.has(field.key)
            return (
              <div key={field.key}>
                <label
                  htmlFor={`ragflow-inline-field-${field.key}`}
                  className='mb-1 block font-medium text-gray-700 text-sm'
                >
                  {t(field.label as Parameters<typeof t>[0])}
                  {field.required && <span className='text-red-500'> *</span>}
                  {isConfiguredPwd && (
                    <span className='ml-2 font-normal text-green-600 text-xs'>
                      {t('connections.editFieldConfigured')}
                    </span>
                  )}
                </label>
                <Input
                  id={`ragflow-inline-field-${field.key}`}
                  data-testid={`ragflow-inline:input:${field.key}`}
                  type={
                    isConfiguredPwd
                      ? 'text' // show the masked preview as plain text, no password obfuscation
                      : field.type === 'password'
                        ? 'password'
                        : field.type === 'number'
                          ? 'number'
                          : 'text'
                  }
                  value={(config[field.key] as string) ?? ''}
                  onChange={(e) => {
                    const newVal = field.type === 'number' ? Number(e.target.value) : e.target.value
                    setConfig({ ...config, [field.key]: newVal })
                  }}
                  onFocus={() => {
                    // Clear masked value on focus for new input
                    if (
                      isConfiguredPwd &&
                      typeof config[field.key] === 'string' &&
                      (config[field.key] as string).includes('****')
                    ) {
                      setConfig({ ...config, [field.key]: '' })
                    }
                  }}
                  placeholder={
                    isConfiguredPwd ? t('connections.editFieldKeepHint') : field.placeholder
                  }
                  disabled={!canSave}
                />
              </div>
            )
          })}
        </div>

        {/* Test connection result */}
        {testResult && (
          <div className='mt-4 flex items-center gap-3 rounded-lg bg-gray-50 px-4 py-3'>
            {testResult.success ? (
              <CheckCircle2 className='h-5 w-5 text-green-500' />
            ) : (
              <XCircle className='h-5 w-5 text-red-500' />
            )}
            <span className={cn('text-sm', testResult.success ? 'text-green-700' : 'text-red-700')}>
              {renderHealthMessage(
                { key: testResult.messageKey, params: testResult.messageParams },
                t
              )}
            </span>
            <span className='text-gray-400 text-xs'>
              {t('connections.wizardLatency', { ms: testResult.latencyMs })}
            </span>
          </div>
        )}

        {/* Action buttons */}
        <div className='mt-6 flex items-center justify-between border-gray-100 border-t pt-4'>
          <div>
            {connection && canDelete && (
              <Button
                variant='outline'
                size='sm'
                className='text-red-600 hover:bg-red-50 hover:text-red-700'
                onClick={() => setDeleteConfirm(true)}
                disabled={isDeleting}
              >
                <Trash2 className='mr-1 h-3.5 w-3.5' />
                {t('common.delete')}
              </Button>
            )}
          </div>
          <div className='flex gap-2'>
            {canSave && (
              <Button
                variant='outline'
                size='sm'
                disabled={isTesting || !hasRequiredFields}
                onClick={handleTestConnection}
              >
                {isTesting ? (
                  <Loader2 className='mr-1 h-3.5 w-3.5 animate-spin' />
                ) : (
                  <RefreshCw className='mr-1 h-3.5 w-3.5' />
                )}
                {t('common.testConnection')}
              </Button>
            )}
            {canSave && (
              <Button size='sm' disabled={isSaving || !hasRequiredFields} onClick={handleSave}>
                {isSaving ? t('common.saving') : t('common.save')}
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Delete confirmation dialog */}
      {deleteConfirm && (
        <div className='fixed inset-0 z-50 flex items-center justify-center bg-black/50'>
          <div className='w-full max-w-sm rounded-xl bg-white p-6 shadow-2xl'>
            <h3 className='mb-2 font-semibold text-gray-900 text-lg'>
              {t('common.confirmDelete')}
            </h3>
            <p className='mb-4 text-gray-500 text-sm'>{t('connections.confirmDeleteDesc')}</p>
            <div className='flex justify-end gap-2'>
              <Button variant='outline' onClick={() => setDeleteConfirm(false)}>
                {t('common.cancel')}
              </Button>
              <Button variant='destructive' onClick={handleDelete} disabled={isDeleting}>
                {isDeleting ? t('common.deleting') : t('common.confirmDelete')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
