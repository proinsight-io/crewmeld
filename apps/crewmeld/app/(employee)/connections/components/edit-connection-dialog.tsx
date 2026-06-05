'use client'

import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import type {
  ConnectionCardData,
  ConnectionType,
  DatabaseSubtype,
  OpenclawEndpoint,
} from '@/lib/connectors/types'
import {
  CONNECTION_CONFIG_FIELDS,
  CONNECTION_TYPE_I18N_KEYS,
  DATABASE_CONFIG_FIELDS_BY_SUBTYPE,
  getDatabaseDisplayLabel,
} from '@/lib/connectors/types'
import { cn } from '@/lib/core/utils/cn'
import { useTranslation } from '@/hooks/use-translation'
import {
  type CustomApiConfig,
  CustomApiEditor,
  customApiConfigToFlat,
  flatToCustomApiConfig,
  type TestResponse,
} from './custom-api-editor'
import { newEmptyEndpoint, OpenclawEndpointsEditor } from './openclaw-endpoints-editor'

interface EditConnectionDialogProps {
  connection: ConnectionCardData | null
  onOpenChange: (open: boolean) => void
  onUpdated: () => void
}

export function EditConnectionDialog({
  connection,
  onOpenChange,
  onUpdated,
}: EditConnectionDialogProps) {
  const { t, tMessage } = useTranslation()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [config, setConfig] = useState<Record<string, string | number | boolean>>({})
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Track which password fields already have a saved value (masked with ****)
  const [configuredPasswordKeys, setConfiguredPasswordKeys] = useState<Set<string>>(new Set())

  // Custom API specific state
  const [customApiConfig, setCustomApiConfig] = useState<CustomApiConfig | null>(null)
  const [customApiResponse, setCustomApiResponse] = useState<TestResponse | null>(null)
  const [isApiTesting, setIsApiTesting] = useState(false)

  // OpenClaw specific state — pool of endpoints; tokens come in masked (****).
  const [openclawEndpoints, setOpenclawEndpoints] = useState<OpenclawEndpoint[] | null>(null)

  const isCustomApi = connection?.type === 'custom_api'
  const isOpenclaw = connection?.type === 'openclaw'

  useEffect(() => {
    if (connection) {
      setName(connection.name)
      setDescription(connection.description ?? '')
      setCustomApiResponse(null)
      setIsApiTesting(false)

      if (connection.type === 'custom_api') {
        setCustomApiConfig(flatToCustomApiConfig(connection.config as Record<string, unknown>))
        setConfig({})
        setConfiguredPasswordKeys(new Set())
        setOpenclawEndpoints(null)
      } else if (connection.type === 'openclaw') {
        setCustomApiConfig(null)
        setConfig({})
        setConfiguredPasswordKeys(new Set())
        const raw = (connection.config as Record<string, unknown>).endpoints
        const list: OpenclawEndpoint[] = Array.isArray(raw)
          ? (raw as unknown[])
              .map((entry) => {
                if (!entry || typeof entry !== 'object') return null
                const e = entry as Record<string, unknown>
                return {
                  label: typeof e.label === 'string' ? e.label : '',
                  url: typeof e.url === 'string' ? e.url : '',
                  token: typeof e.token === 'string' ? e.token : '',
                }
              })
              .filter((x): x is OpenclawEndpoint => x !== null)
          : []
        setOpenclawEndpoints(list.length > 0 ? list : [newEmptyEndpoint()])
      } else {
        setCustomApiConfig(null)
        setOpenclawEndpoints(null)
        const cfg: Record<string, string | number | boolean> = {}
        const pwdConfigured = new Set<string>()
        const pwdKeys = new Set(
          (CONNECTION_CONFIG_FIELDS[connection.type as ConnectionType] ?? [])
            .filter((f) => f.type === 'password')
            .map((f) => f.key)
        )
        for (const [k, v] of Object.entries(connection.config)) {
          if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
            if (pwdKeys.has(k) && typeof v === 'string' && v.includes('****')) {
              pwdConfigured.add(k)
              cfg[k] = ''
            } else {
              cfg[k] = v
            }
          }
        }
        setConfiguredPasswordKeys(pwdConfigured)
        setConfig(cfg)
      }
      setError(null)
    }
  }, [connection])

  const handleTestApi = useCallback(async () => {
    if (!connection || !customApiConfig) return
    setIsApiTesting(true)
    setCustomApiResponse(null)
    try {
      const res = await fetch('/api/employee/connectors/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'custom_api',
          config: customApiConfigToFlat(customApiConfig),
        }),
      })
      const json = await res.json()
      if (json.success && json.data?.response) {
        setCustomApiResponse({
          status: json.data.response.status,
          statusText: json.data.response.statusText,
          latencyMs: json.data.latencyMs,
          body: json.data.response.body,
          headers: json.data.response.headers ?? {},
        })
      }
    } catch {
      /* ignore */
    } finally {
      setIsApiTesting(false)
    }
  }, [connection, customApiConfig])

  const handleSave = useCallback(async () => {
    if (!connection || !name.trim()) return
    setIsSaving(true)
    setError(null)
    try {
      const payload: Record<string, unknown> = {
        name: name.trim(),
        description: description.trim() || undefined,
      }

      if (isCustomApi && customApiConfig) {
        payload.config = customApiConfigToFlat(customApiConfig)
      } else if (isOpenclaw && openclawEndpoints) {
        payload.config = {
          endpoints: openclawEndpoints
            .map((ep) => ({
              label: ep.label.trim(),
              url: ep.url.trim(),
              token: ep.token,
            }))
            .filter((ep) => ep.label && ep.url && ep.token),
        }
      } else {
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
      }

      const res = await fetch(`/api/employee/connectors/${connection.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const json = await res.json()
      if (json.success) {
        onOpenChange(false)
        onUpdated()
      } else {
        setError(tMessage(json) || t('connections.wizardUpdateFailed'))
      }
    } catch {
      setError(t('common.networkError'))
    } finally {
      setIsSaving(false)
    }
  }, [
    connection,
    name,
    description,
    config,
    configuredPasswordKeys,
    isCustomApi,
    customApiConfig,
    isOpenclaw,
    openclawEndpoints,
    onOpenChange,
    onUpdated,
    t,
    tMessage,
  ])

  const fields = (() => {
    if (!connection) return []
    if (connection.type === 'database') {
      const dbType = connection.config?.dbType as DatabaseSubtype | undefined
      if (dbType && DATABASE_CONFIG_FIELDS_BY_SUBTYPE[dbType]) {
        return DATABASE_CONFIG_FIELDS_BY_SUBTYPE[dbType]
      }
    }
    return CONNECTION_CONFIG_FIELDS[connection.type as ConnectionType] ?? []
  })()

  return (
    <Dialog open={connection !== null} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          'max-h-[90vh] overflow-y-auto',
          isCustomApi || isOpenclaw ? 'max-w-3xl' : 'max-w-md'
        )}
      >
        <DialogHeader>
          <DialogTitle>
            {t('connections.editTitle', {
              type: connection
                ? connection.type === 'database'
                  ? (getDatabaseDisplayLabel(connection.config) ?? t('connections.typeDatabase'))
                  : t(CONNECTION_TYPE_I18N_KEYS[connection.type] as Parameters<typeof t>[0])
                : '',
            })}
          </DialogTitle>
        </DialogHeader>

        {error && (
          <div className='mb-3 rounded-lg border border-red-200 bg-red-50 p-2 text-red-600 text-xs'>
            {error}
          </div>
        )}

        <div className='space-y-4'>
          {/* Name + description */}
          <div className={cn(isCustomApi ? 'grid grid-cols-2 gap-3' : 'space-y-4')}>
            <div>
              <label
                htmlFor='edit-connection-name'
                className='mb-1 block font-medium text-gray-700 text-sm'
              >
                {t('connections.wizardConnectionName')} <span className='text-red-500'>*</span>
              </label>
              <Input
                id='edit-connection-name'
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={100}
              />
            </div>
            <div>
              <label
                htmlFor='edit-connection-description'
                className='mb-1 block font-medium text-gray-700 text-sm'
              >
                {t('common.description')}
              </label>
              <Input
                id='edit-connection-description'
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={500}
              />
            </div>
          </div>

          {/* Custom API: Postman editor */}
          {isCustomApi && customApiConfig ? (
            <CustomApiEditor
              value={customApiConfig}
              onChange={(next) => {
                // Clear previous response on URL change
                if (next.apiEndpoint !== customApiConfig.apiEndpoint) {
                  setCustomApiResponse(null)
                }
                setCustomApiConfig(next)
              }}
              testResponse={customApiResponse}
              isTesting={isApiTesting}
              onSend={handleTestApi}
              compact
            />
          ) : isOpenclaw && openclawEndpoints ? (
            <OpenclawEndpointsEditor
              value={openclawEndpoints}
              onChange={setOpenclawEndpoints}
              disabled={isSaving}
            />
          ) : (
            /* Other types: original field form */
            <>
              {fields.map((field) => {
                const isConfiguredPwd = configuredPasswordKeys.has(field.key)
                return (
                  <div key={field.key}>
                    <label
                      htmlFor={`edit-connection-field-${field.key}`}
                      className='mb-1 block font-medium text-gray-700 text-sm'
                    >
                      {field.label}
                      {isConfiguredPwd && (
                        <span className='ml-2 font-normal text-green-600 text-xs'>
                          {t('connections.editFieldConfigured')}
                        </span>
                      )}
                    </label>
                    {field.type === 'boolean' ? (
                      <div className='flex items-center gap-2 pt-1'>
                        <Switch
                          id={`edit-connection-field-${field.key}`}
                          checked={Boolean(config[field.key])}
                          onCheckedChange={(checked) =>
                            setConfig({ ...config, [field.key]: checked })
                          }
                        />
                        <span className='text-gray-500 text-xs'>
                          {config[field.key] ? t('common.enabled') : t('common.disabled')}
                        </span>
                      </div>
                    ) : (
                      <Input
                        id={`edit-connection-field-${field.key}`}
                        type={
                          field.type === 'password'
                            ? 'password'
                            : field.type === 'number'
                              ? 'number'
                              : 'text'
                        }
                        value={(config[field.key] as string) ?? ''}
                        onChange={(e) =>
                          setConfig({
                            ...config,
                            [field.key]:
                              field.type === 'number' ? Number(e.target.value) : e.target.value,
                          })
                        }
                        placeholder={
                          isConfiguredPwd ? t('connections.editFieldKeepHint') : field.placeholder
                        }
                      />
                    )}
                  </div>
                )
              })}
            </>
          )}
        </div>

        <div className='mt-4 flex justify-end gap-2'>
          <Button variant='outline' onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button onClick={handleSave} disabled={isSaving || !name.trim()}>
            {isSaving ? t('common.saving') : t('common.save')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
