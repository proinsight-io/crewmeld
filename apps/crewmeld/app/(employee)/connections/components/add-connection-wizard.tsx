'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { CheckCircle2, Loader2, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import type {
  ConnectionTestResult,
  ConnectionType,
  DatabaseSubtype,
  OpenclawEndpoint,
} from '@/lib/connectors/types'
import {
  CONNECTION_CONFIG_FIELDS,
  CONNECTION_TYPE_I18N_KEYS,
  CONNECTION_TYPE_ICONS,
  DATABASE_CONFIG_FIELDS_BY_SUBTYPE,
  DATABASE_SUBTYPE_DEFAULT_PORTS,
  DATABASE_SUBTYPE_ICONS,
  DATABASE_SUBTYPE_LABELS,
  DATABASE_SUBTYPES,
  SYSTEM_CONNECTION_TYPE_LIST,
} from '@/lib/connectors/types'
import { cn } from '@/lib/core/utils/cn'
import { renderHealthMessage } from '@/lib/i18n/render-health-message'
import { useTranslation } from '@/hooks/use-translation'
import {
  type CustomApiConfig,
  CustomApiEditor,
  customApiConfigToFlat,
  getDefaultCustomApiConfig,
  type TestResponse,
} from './custom-api-editor'
import { newEmptyEndpoint, OpenclawEndpointsEditor } from './openclaw-endpoints-editor'

/** Connection types that only allow one connection (singleton types) */
const SINGLETON_TYPES: ReadonlySet<ConnectionType> = new Set<ConnectionType>(['ragflow'])

interface AddConnectionWizardProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: () => void
  /** Set of existing connection types */
  existingTypes?: Set<ConnectionType>
  /** Pre-selected type from tab, skip first step */
  preselectedType?: ConnectionType
}

export function AddConnectionWizard({
  open,
  onOpenChange,
  onCreated,
  existingTypes,
  preselectedType,
}: AddConnectionWizardProps) {
  const { t, tMessage } = useTranslation()
  const hasPreselect = !!preselectedType
  const isPreselectedDb = preselectedType === 'database'
  /** Skip "select type" step when pre-selecting non-database type */
  const skipSelect = hasPreselect && !isPreselectedDb
  const allSteps = useMemo(
    () =>
      skipSelect
        ? [t('connections.wizardStepConfig'), t('connections.wizardStepTest')]
        : [
            t('connections.wizardStepSelect'),
            t('connections.wizardStepConfig'),
            t('connections.wizardStepTest'),
          ],
    [t, skipSelect]
  )
  /** Semantic step numbers, offset by skipSelect */
  const SELECT_STEP = skipSelect ? -1 : 1
  const CONFIG_STEP = skipSelect ? 1 : 2
  const TEST_STEP = skipSelect ? 2 : 3
  const [step, setStep] = useState(skipSelect ? CONFIG_STEP : 1)
  const [selectedDbSubtype, setSelectedDbSubtype] = useState<DatabaseSubtype | null>(null)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [config, setConfig] = useState<Record<string, string | number | boolean>>({})
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null)
  const [isTesting, setIsTesting] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Initialize selectedType when pre-selecting type
  const [selectedType, _setSelectedType] = useState<ConnectionType | null>(preselectedType ?? null)
  const setSelectedType = _setSelectedType

  // Custom API specific state
  const [customApiConfig, setCustomApiConfig] = useState<CustomApiConfig>(
    getDefaultCustomApiConfig()
  )
  const [customApiResponse, setCustomApiResponse] = useState<TestResponse | null>(null)

  // OpenClaw specific state — pool of {label, url, token}.
  const [openclawEndpoints, setOpenclawEndpoints] = useState<OpenclawEndpoint[]>([
    newEmptyEndpoint(),
  ])

  const isCustomApi = selectedType === 'custom_api'
  const isOpenclaw = selectedType === 'openclaw'

  const reset = useCallback(() => {
    setStep(1)
    setSelectedType(preselectedType ?? null)
    setSelectedDbSubtype(null)
    setName('')
    setDescription('')
    setConfig({})
    setCustomApiConfig(getDefaultCustomApiConfig())
    setCustomApiResponse(null)
    setOpenclawEndpoints([newEmptyEndpoint()])
    setTestResult(null)
    setIsTesting(false)
    setIsSaving(false)
    setError(null)
  }, [preselectedType])

  // Reset state based on latest preselectedType when dialog opens
  useEffect(() => {
    if (open) {
      reset()
    }
  }, [open, reset])

  const handleClose = useCallback(() => {
    reset()
    onOpenChange(false)
  }, [reset, onOpenChange])

  const buildSaveConfig = useCallback((): Record<string, unknown> => {
    if (isCustomApi) return customApiConfigToFlat(customApiConfig)
    if (isOpenclaw) {
      return {
        endpoints: openclawEndpoints
          .map((ep) => ({
            label: ep.label.trim(),
            url: ep.url.trim(),
            token: ep.token,
          }))
          .filter((ep) => ep.label && ep.url && ep.token),
      }
    }
    return config
  }, [isCustomApi, customApiConfig, isOpenclaw, openclawEndpoints, config])

  const handleTestConnection = useCallback(async () => {
    if (!selectedType) return
    setIsTesting(true)
    setTestResult(null)
    setCustomApiResponse(null)
    setError(null)
    try {
      const testConfig = buildSaveConfig()
      const res = await fetch('/api/employee/connectors/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: selectedType, config: testConfig }),
      })
      const json = await res.json()
      if (json.success) {
        setTestResult(json.data)
        // If backend returns response object (custom API), set response
        if (json.data?.response) {
          setCustomApiResponse({
            status: json.data.response.status,
            statusText: json.data.response.statusText,
            latencyMs: json.data.latencyMs,
            body: json.data.response.body,
            headers: json.data.response.headers ?? {},
          })
        } else if (isCustomApi && !json.data?.success) {
          // Custom API request failed without response (e.g. unreachable), construct error
          setCustomApiResponse({
            status: 0,
            statusText: 'Error',
            latencyMs: json.data?.latencyMs ?? 0,
            body: json.data?.message ?? t('connections.wizardTestFailed'),
            headers: {},
          })
        }
      } else {
        if (isCustomApi) {
          setCustomApiResponse({
            status: 0,
            statusText: 'Error',
            latencyMs: 0,
            body: tMessage(json) || t('connections.wizardTestFailed'),
            headers: {},
          })
        }
        setError(tMessage(json) || t('connections.wizardTestFailed'))
      }
    } catch {
      if (isCustomApi) {
        setCustomApiResponse({
          status: 0,
          statusText: 'Error',
          latencyMs: 0,
          body: t('common.networkError'),
          headers: {},
        })
      }
      setError(t('common.networkError'))
    } finally {
      setIsTesting(false)
    }
  }, [selectedType, buildSaveConfig, isCustomApi, t, tMessage])

  const handleSave = useCallback(async () => {
    if (!selectedType || !name.trim()) return
    setIsSaving(true)
    setError(null)
    try {
      const saveConfig = buildSaveConfig()
      const res = await fetch('/api/employee/connectors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          type: selectedType,
          description: description.trim() || undefined,
          config: saveConfig,
        }),
      })
      const json = await res.json()
      if (json.success) {
        // Auto-trigger health check after save (non-blocking)
        const connId = json.data?.id
        if (connId) {
          fetch(`/api/employee/connectors/${connId}/health-check`, { method: 'POST' }).catch(
            () => {}
          )
        }
        handleClose()
        onCreated()
      } else {
        setError(tMessage(json) || t('connections.wizardSaveFailed'))
      }
    } catch {
      setError(t('common.networkError'))
    } finally {
      setIsSaving(false)
    }
  }, [
    selectedType,
    name,
    description,
    buildSaveConfig,
    handleClose,
    onCreated,
    t,
    tMessage,
  ])

  const canGoStep2 = selectedType !== null
  const isOpenclawEndpointsValid =
    isOpenclaw &&
    openclawEndpoints.length > 0 &&
    openclawEndpoints.every(
      (ep) => ep.label.trim().length > 0 && ep.url.trim().length > 0 && ep.token.length > 0
    )
  const canGoStep3 = isCustomApi
    ? name.trim().length > 0 && customApiConfig.apiEndpoint.trim().length > 0
    : isOpenclaw
      ? name.trim().length > 0 && isOpenclawEndpointsValid
      : name.trim().length > 0

  const fields =
    selectedType === 'database' && selectedDbSubtype
      ? DATABASE_CONFIG_FIELDS_BY_SUBTYPE[selectedDbSubtype]
      : selectedType
        ? CONNECTION_CONFIG_FIELDS[selectedType]
        : []

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) handleClose()
      }}
    >
      <DialogContent
        className={cn(
          'flex max-h-[90vh] flex-col overflow-y-auto',
          isCustomApi ? 'max-w-3xl' : 'max-w-lg'
        )}
      >
        <DialogHeader>
          <DialogTitle>{t('connections.wizardAddTitle')}</DialogTitle>
        </DialogHeader>

        {/* Step indicator (hidden for custom_api since it skips to config directly) */}
        {!isCustomApi && (
          <div className='mb-4 flex items-center justify-center gap-2'>
            {allSteps.map((label, i) => {
              const s = i + 1
              const isActive = s === step
              const isCompleted = s < step
              return (
                <div key={s} className='flex items-center'>
                  <div className='flex flex-col items-center'>
                    <div
                      className={cn(
                        'flex h-8 w-8 items-center justify-center rounded-full font-medium text-xs',
                        isActive && 'bg-blue-600 text-white',
                        isCompleted && 'bg-green-600 text-white',
                        !isActive && !isCompleted && 'bg-gray-200 text-gray-500'
                      )}
                    >
                      {isCompleted ? '✓' : s}
                    </div>
                    <span
                      className={cn('mt-1 text-xs', isActive ? 'text-blue-600' : 'text-gray-400')}
                    >
                      {label}
                    </span>
                  </div>
                  {s < allSteps.length && (
                    <div
                      className={cn(
                        'mx-2 mt-[-1rem] h-px w-8',
                        s < step ? 'bg-green-600' : 'bg-gray-200'
                      )}
                    />
                  )}
                </div>
              )
            })}
          </div>
        )}

        {error && (
          <div className='mb-3 rounded-lg border border-red-200 bg-red-50 p-2 text-red-600 text-xs'>
            {error}
          </div>
        )}

        {/* Step 1: Select type (or db subtype when preselected as database) */}
        {step === SELECT_STEP && (
          <div className='flex flex-col gap-3'>
            {isPreselectedDb ? (
              <>
                <p className='text-gray-500 text-sm'>{t('connections.wizardSelectDbType')}</p>
                <div className='max-h-[50vh] overflow-y-auto'>
                  <div className='grid grid-cols-2 gap-2'>
                    {DATABASE_SUBTYPES.map((dbType) => (
                      <button
                        key={dbType}
                        onClick={() => {
                          setSelectedDbSubtype(dbType)
                          setConfig((prev) => ({
                            ...prev,
                            dbType,
                            port: DATABASE_SUBTYPE_DEFAULT_PORTS[dbType],
                          }))
                        }}
                        className={cn(
                          'flex items-center gap-2 rounded-lg border px-3 py-2 text-left transition-all',
                          selectedDbSubtype === dbType
                            ? 'border-blue-600 bg-blue-50'
                            : 'border-gray-200 hover:border-gray-300'
                        )}
                      >
                        <span className='text-lg'>{DATABASE_SUBTYPE_ICONS[dbType]}</span>
                        <span className='font-medium text-gray-900 text-sm'>
                          {DATABASE_SUBTYPE_LABELS[dbType]}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
                <div className='flex justify-end border-gray-100 border-t pt-3'>
                  <Button onClick={() => setStep(CONFIG_STEP)} disabled={!selectedDbSubtype}>
                    {t('common.next')}
                  </Button>
                </div>
              </>
            ) : (
              <>
                <p className='text-gray-500 text-sm'>{t('connections.wizardSelectHint')}</p>
                <div className='max-h-[50vh] overflow-y-auto'>
                  <div className='grid grid-cols-2 gap-3'>
                    {SYSTEM_CONNECTION_TYPE_LIST.map((type) => {
                      const isDisabled = SINGLETON_TYPES.has(type) && !!existingTypes?.has(type)
                      return (
                        <button
                          key={type}
                          title={isDisabled ? t('connections.wizardTypeExistsHint') : undefined}
                          disabled={isDisabled}
                          onClick={() => {
                            if (isDisabled) return
                            if (type === 'database') {
                              setSelectedType('database')
                              setSelectedDbSubtype(null)
                            } else {
                              setSelectedType(type)
                              setSelectedDbSubtype(null)
                            }
                          }}
                          className={cn(
                            'flex items-center gap-3 rounded-lg border p-3 text-left transition-all',
                            isDisabled
                              ? 'cursor-not-allowed border-gray-200 bg-gray-100 opacity-50'
                              : selectedType === type
                                ? 'border-blue-600 bg-blue-50'
                                : 'border-gray-200 hover:border-gray-300'
                          )}
                        >
                          <span className='text-xl'>{CONNECTION_TYPE_ICONS[type]}</span>
                          <span
                            className={cn(
                              'font-medium text-sm',
                              isDisabled ? 'text-gray-400' : 'text-gray-900'
                            )}
                          >
                            {t(CONNECTION_TYPE_I18N_KEYS[type] as Parameters<typeof t>[0])}
                          </span>
                        </button>
                      )
                    })}
                  </div>

                  {/* Expand subtypes after selecting database */}
                  {selectedType === 'database' && (
                    <div className='mt-3'>
                      <p className='mb-2 text-gray-500 text-xs'>
                        {t('connections.wizardSelectDbType')}
                      </p>
                      <div className='grid grid-cols-2 gap-2'>
                        {DATABASE_SUBTYPES.map((dbType) => (
                          <button
                            key={dbType}
                            onClick={() => {
                              setSelectedDbSubtype(dbType)
                              setConfig((prev) => ({
                                ...prev,
                                dbType,
                                port: DATABASE_SUBTYPE_DEFAULT_PORTS[dbType],
                              }))
                            }}
                            className={cn(
                              'flex items-center gap-2 rounded-lg border px-3 py-2 text-left transition-all',
                              selectedDbSubtype === dbType
                                ? 'border-blue-600 bg-blue-50'
                                : 'border-gray-200 hover:border-gray-300'
                            )}
                          >
                            <span className='text-lg'>{DATABASE_SUBTYPE_ICONS[dbType]}</span>
                            <span className='font-medium text-gray-900 text-sm'>
                              {DATABASE_SUBTYPE_LABELS[dbType]}
                            </span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
                <div className='flex justify-end border-gray-100 border-t pt-3'>
                  <Button
                    onClick={() => setStep(CONFIG_STEP)}
                    disabled={!canGoStep2 || (selectedType === 'database' && !selectedDbSubtype)}
                  >
                    {t('common.next')}
                  </Button>
                </div>
              </>
            )}
          </div>
        )}

        {/* Step 2: Config form */}
        {step === CONFIG_STEP && selectedType && (
          <div className='flex min-h-0 flex-col gap-4'>
            <div className='flex-1 overflow-y-auto p-1'>
              <div className='space-y-4'>
                {/* Name + description（General） */}
                <div className='grid grid-cols-2 gap-3'>
                  <div>
                    <label
                      htmlFor='add-connection-name'
                      className='mb-1 block font-medium text-gray-700 text-sm'
                    >
                      {t('connections.wizardConnectionName')}{' '}
                      <span className='text-red-500'>*</span>
                    </label>
                    <Input
                      id='add-connection-name'
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder={`${t('connections.wizardExamplePrefix')}${selectedDbSubtype ? DATABASE_SUBTYPE_LABELS[selectedDbSubtype] : t(CONNECTION_TYPE_I18N_KEYS[selectedType] as Parameters<typeof t>[0])}${t('common.mainApp')}`}
                      maxLength={100}
                    />
                  </div>
                  <div>
                    <label
                      htmlFor='add-connection-description'
                      className='mb-1 block font-medium text-gray-700 text-sm'
                    >
                      {t('common.description')}
                    </label>
                    <Input
                      id='add-connection-description'
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      placeholder={t('connections.wizardOptional')}
                      maxLength={500}
                    />
                  </div>
                </div>

                {/* Custom API: Postman-style editor */}
                {isCustomApi ? (
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
                    isTesting={isTesting}
                    onSend={handleTestConnection}
                    compact
                  />
                ) : isOpenclaw ? (
                  <OpenclawEndpointsEditor
                    value={openclawEndpoints}
                    onChange={setOpenclawEndpoints}
                    disabled={isSaving || isTesting}
                  />
                ) : (
                  /* Other types: original field form */
                  <>
                    {fields.map((field) => (
                      <div key={field.key}>
                        <label
                          htmlFor={`add-connection-field-${field.key}`}
                          className='mb-1 block font-medium text-gray-700 text-sm'
                        >
                          {t(field.label as Parameters<typeof t>[0])}
                          {field.required && <span className='text-red-500'> *</span>}
                        </label>
                        {field.type === 'boolean' ? (
                          <div className='flex items-center gap-2 pt-1'>
                            <Switch
                              id={`add-connection-field-${field.key}`}
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
                            id={`add-connection-field-${field.key}`}
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
                              field.placeholder
                                ? t(field.placeholder as Parameters<typeof t>[0])
                                : undefined
                            }
                          />
                        )}
                      </div>
                    ))}
                  </>
                )}
              </div>
            </div>
            <div
              className={cn(
                'flex border-gray-100 border-t pt-3',
                isCustomApi || skipSelect ? 'justify-end' : 'justify-between'
              )}
            >
              {!isCustomApi && !skipSelect && (
                <Button variant='outline' onClick={() => setStep(SELECT_STEP)}>
                  {t('common.previous')}
                </Button>
              )}
              {isCustomApi ? (
                <Button onClick={handleSave} disabled={isSaving || !canGoStep3}>
                  {isSaving ? t('common.saving') : t('connections.wizardSaveConnection')}
                </Button>
              ) : (
                <Button
                  onClick={() => {
                    setStep(TEST_STEP)
                    handleTestConnection()
                  }}
                  disabled={!canGoStep3}
                >
                  {t('common.testConnection')}
                </Button>
              )}
            </div>
          </div>
        )}

        {/* Step 3: Test result */}
        {step === TEST_STEP && (
          <div className='flex flex-col gap-4'>
            <div className='flex-1 overflow-y-auto'>
              {isTesting && (
                <div className='flex flex-col items-center gap-3 py-8'>
                  <Loader2 className='h-8 w-8 animate-spin text-blue-600' />
                  <p className='text-gray-500 text-sm'>
                    {t('connections.wizardTestingConnection')}
                  </p>
                </div>
              )}
              {!isTesting && testResult && (
                <div className='flex flex-col items-center gap-3 py-6'>
                  {testResult.success ? (
                    <CheckCircle2 className='h-12 w-12 text-green-500' />
                  ) : (
                    <XCircle className='h-12 w-12 text-red-500' />
                  )}
                  <p
                    className={cn(
                      'font-medium text-sm',
                      testResult.success ? 'text-green-700' : 'text-red-700'
                    )}
                  >
                    {renderHealthMessage(
                      { key: testResult.messageKey, params: testResult.messageParams },
                      t
                    )}
                  </p>
                  <p className='text-gray-400 text-xs'>
                    {t('connections.wizardLatency', { ms: testResult.latencyMs })}
                  </p>
                  {testResult.details && (
                    <div className='w-full rounded-lg bg-gray-50 p-3 text-gray-600 text-xs'>
                      {Object.entries(testResult.details).map(([k, v]) => (
                        <div key={k}>
                          <span className='font-medium'>{k}:</span> {v}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {!isTesting && !testResult && !error && (
                <div className='py-8 text-center text-gray-400 text-sm'>
                  {t('connections.wizardWaitingTest')}
                </div>
              )}
            </div>
            <div className='flex justify-between border-gray-100 border-t pt-3'>
              <Button variant='outline' onClick={() => setStep(CONFIG_STEP)}>
                {t('common.previous')}
              </Button>
              <div className='flex gap-2'>
                <Button variant='outline' onClick={handleTestConnection} disabled={isTesting}>
                  {t('connections.wizardRetest')}
                </Button>
                <Button onClick={handleSave} disabled={isSaving || isTesting}>
                  {isSaving ? t('common.saving') : t('connections.wizardSaveConnection')}
                </Button>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
