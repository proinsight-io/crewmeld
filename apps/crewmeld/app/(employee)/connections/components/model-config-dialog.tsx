'use client'

import { useCallback, useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
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
import { Label } from '@/components/ui/label'
import type { ModelConfigData, ModelTestResult } from '@/lib/models/types'
import { type TranslationKey, useTranslation } from '@/hooks/use-translation'
import { PROVIDER_DEFINITIONS } from '@/providers/models'
import {
  type ExtraParamRow,
  ExtraParamsEditor,
  extraParamsToRows,
  rowsToExtraParams,
} from './extra-params-editor'

/**
 * Fallback endpoint for the Claude coding provider. When the user leaves the
 * custom-endpoint field empty, this value is persisted so the dev-studio
 * container always receives a concrete base URL. Mirrors
 * CODING_DEFAULT_ENDPOINTS['claude-coding'] in add-model-wizard.tsx.
 */
const CLAUDE_CODING_DEFAULT_ENDPOINT = 'https://api.anthropic.com/v1'

interface ModelConfigDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  config: ModelConfigData | null
  onSaved: () => void
}

export function ModelConfigDialog({ open, onOpenChange, config, onSaved }: ModelConfigDialogProps) {
  const { t, tMessage } = useTranslation()
  const [displayName, setDisplayName] = useState('')
  const [modelName, setModelName] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [apiEndpoint, setApiEndpoint] = useState('')
  const [temperature, setTemperature] = useState('0.7')
  const [maxTokens, setMaxTokens] = useState('4096')
  const [codingFastModel, setCodingFastModel] = useState('')
  const [codingSonnetModel, setCodingSonnetModel] = useState('')
  const [codingOpusModel, setCodingOpusModel] = useState('')
  const [extraParams, setExtraParams] = useState<ExtraParamRow[]>([])
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<ModelTestResult | null>(null)

  const resetForm = useCallback(() => {
    if (config) {
      setDisplayName(config.displayName)
      setModelName(config.modelName ?? '')
      setApiKey('')
      setApiEndpoint(config.apiEndpoint ?? '')
      setTemperature(String(config.defaultParams.temperature))
      setMaxTokens(String(config.defaultParams.maxTokens))
      setCodingFastModel(config.defaultParams.codingFastModel ?? '')
      setCodingSonnetModel(config.defaultParams.codingSonnetModel ?? '')
      setCodingOpusModel(config.defaultParams.codingOpusModel ?? '')
      setExtraParams(extraParamsToRows(config.defaultParams.extraParams))
    }
    setTestResult(null)
  }, [config])

  // When the dialog is opened via the parent's `open` prop, run resetForm to repopulate the form
  useEffect(() => {
    if (open && config) {
      resetForm()
    }
  }, [open, config, resetForm])

  const handleOpenChange = useCallback(
    (value: boolean) => {
      onOpenChange(value)
    },
    [onOpenChange]
  )

  const handleTest = useCallback(async () => {
    if (!config) return
    setTesting(true)
    setTestResult(null)
    try {
      // Pass the currently edited model name so test uses the unsaved value.
      // Other fields (apiKey/apiEndpoint) still need saving for test to pick them up.
      const trimmedModel = modelName.trim()
      const res = await fetch(`/api/employee/models/${config.id}/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(trimmedModel ? { model: trimmedModel } : {}),
      })
      const data = await res.json()
      if (data.success && data.data) {
        setTestResult(data.data)
      } else {
        setTestResult({
          success: false,
          message: tMessage(data) || t('connections.modelConfigNetworkFailed'),
          latencyMs: 0,
          model: '',
        })
      }
    } catch {
      setTestResult({
        success: false,
        message: t('connections.modelConfigNetworkFailed'),
        latencyMs: 0,
        model: '',
      })
    } finally {
      setTesting(false)
    }
  }, [config, modelName, t, tMessage])

  const handleSave = useCallback(async () => {
    if (!config) return
    setSaving(true)
    try {
      const body: Record<string, unknown> = { displayName }
      body.modelName = modelName.trim() || null
      if (apiKey) body.apiKey = apiKey
      // Claude coding: an empty endpoint falls back to the system default.
      const effectiveEndpoint =
        config.providerId === 'claude-coding' && !apiEndpoint.trim()
          ? CLAUDE_CODING_DEFAULT_ENDPOINT
          : apiEndpoint
      if (effectiveEndpoint !== (config.apiEndpoint ?? '')) body.apiEndpoint = effectiveEndpoint
      body.defaultParams = PROVIDER_DEFINITIONS[config.providerId]?.category === 'coding'
        ? {
            // Send null for cleared fields so PATCH's spread merge overwrites
            // any previously-stored value instead of leaving it stale.
            codingFastModel: codingFastModel.trim() || null,
            codingSonnetModel: codingSonnetModel.trim() || null,
            codingOpusModel: codingOpusModel.trim() || null,
          }
        : {
            temperature: Number.parseFloat(temperature),
            maxTokens: Number.parseInt(maxTokens, 10),
            // Sent every save so params cleared in the editor are overwritten
            // by PATCH's spread merge.
            extraParams: rowsToExtraParams(extraParams),
          }
      await fetch(`/api/employee/models/${config.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      onSaved()
      onOpenChange(false)
    } finally {
      setSaving(false)
    }
  }, [
    config,
    displayName,
    modelName,
    apiKey,
    apiEndpoint,
    temperature,
    maxTokens,
    codingFastModel,
    codingSonnetModel,
    codingOpusModel,
    extraParams,
    onSaved,
    onOpenChange,
  ])

  if (!config) return null

  const providerName =
    t(`connections.providerName_${config.providerId}` as TranslationKey) || config.providerMeta.name
  const providerDesc =
    t(`connections.providerDesc_${config.providerId}` as TranslationKey) ||
    config.providerMeta.description

  // Required-field validation applies only to coding-category providers. API
  // key stays optional when one is already configured (empty = keep existing).
  // Claude coding is exempt on the endpoint (empty falls back to the default).
  const isCodingProvider = PROVIDER_DEFINITIONS[config.providerId]?.category === 'coding'
  const isClaudeCoding = config.providerId === 'claude-coding'
  const canSave =
    !!displayName.trim() &&
    (!isCodingProvider ||
      (!!modelName.trim() &&
        (config.hasApiKey || !!apiKey.trim()) &&
        (isClaudeCoding || !!apiEndpoint.trim())))
  const requiredMark = <span className='text-red-500'>*</span>

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className='flex max-h-[85vh] flex-col sm:max-w-md'>
        <DialogHeader className='shrink-0'>
          <DialogTitle>{t('connections.modelEditTitle', { name: config.displayName })}</DialogTitle>
          <DialogDescription>
            {providerName} — {providerDesc}
          </DialogDescription>
        </DialogHeader>

        <div className='-mr-2 flex-1 space-y-4 overflow-y-auto py-2 pr-2'>
          <div className='space-y-2'>
            <Label htmlFor='displayName'>
              {t('connections.modelConfigDisplayName')} {isCodingProvider && requiredMark}
            </Label>
            <Input
              id='displayName'
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder={providerName}
            />
          </div>

          <div className='space-y-2'>
            <Label htmlFor='modelName'>
              {t('connections.modelConfigModelName')} {isCodingProvider && requiredMark}
            </Label>
            <Input
              id='modelName'
              value={modelName}
              onChange={(e) => setModelName(e.target.value)}
              placeholder={
                config.providerMeta.defaultModel || t('connections.modelConfigModelNamePlaceholder')
              }
            />
            <p className='text-gray-400 text-xs'>{t('connections.modelConfigModelNameHint')}</p>
          </div>

          <div className='space-y-2'>
            <Label htmlFor='apiKey'>
              API Key{' '}
              {isCodingProvider && !config.hasApiKey && requiredMark}
              {config.providerId === 'ollama' && (
                <span className='text-gray-400 text-xs'>
                  {t('connections.modelConfigApiKeyOptional')}
                </span>
              )}
              {config.hasApiKey && (
                <span className='ml-2 font-normal text-green-600 text-xs'>
                  {t('connections.editFieldConfigured')}
                </span>
              )}
            </Label>
            <Input
              id='apiKey'
              type='password'
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={
                config.hasApiKey
                  ? t('connections.editFieldKeepHint')
                  : t('connections.modelConfigApiKeyPlaceholder')
              }
            />
          </div>

          <div className='space-y-2'>
            <Label htmlFor='apiEndpoint'>
              {t('connections.modelConfigEndpointLabel')}{' '}
              {isCodingProvider && !isClaudeCoding ? (
                requiredMark
              ) : (
                <span className='text-gray-400 text-xs'>
                  {t('connections.modelConfigEndpointOptional')}
                </span>
              )}
            </Label>
            <Input
              id='apiEndpoint'
              value={apiEndpoint}
              onChange={(e) => setApiEndpoint(e.target.value)}
              placeholder={
                config.providerId === 'ollama'
                  ? 'http://localhost:11434'
                  : isClaudeCoding
                    ? CLAUDE_CODING_DEFAULT_ENDPOINT
                    : 'https://api.example.com'
              }
            />
            {isClaudeCoding && (
              <p className='text-gray-400 text-xs'>
                {t('connections.modelEndpointClaudeDefaultHint')}
              </p>
            )}
          </div>

          {PROVIDER_DEFINITIONS[config.providerId]?.category === 'coding' && (
            <div className='space-y-4'>
              <div className='space-y-2'>
                <Label htmlFor='codingFast'>
                  {t('connections.modelCodingFast')}{' '}
                  <span className='text-gray-400 text-xs'>
                    {t('connections.modelCodingTierOptional')}
                  </span>
                </Label>
                <Input
                  id='codingFast'
                  value={codingFastModel}
                  onChange={(e) => setCodingFastModel(e.target.value)}
                  placeholder={modelName || config.providerMeta.defaultModel}
                />
              </div>
              <div className='space-y-2'>
                <Label htmlFor='codingSonnet'>
                  {t('connections.modelCodingSonnet')}{' '}
                  <span className='text-gray-400 text-xs'>
                    {t('connections.modelCodingTierOptional')}
                  </span>
                </Label>
                <Input
                  id='codingSonnet'
                  value={codingSonnetModel}
                  onChange={(e) => setCodingSonnetModel(e.target.value)}
                  placeholder={modelName || config.providerMeta.defaultModel}
                />
              </div>
              <div className='space-y-2'>
                <Label htmlFor='codingOpus'>
                  {t('connections.modelCodingOpus')}{' '}
                  <span className='text-gray-400 text-xs'>
                    {t('connections.modelCodingTierOptional')}
                  </span>
                </Label>
                <Input
                  id='codingOpus'
                  value={codingOpusModel}
                  onChange={(e) => setCodingOpusModel(e.target.value)}
                  placeholder={modelName || config.providerMeta.defaultModel}
                />
              </div>
            </div>
          )}

          {PROVIDER_DEFINITIONS[config.providerId]?.category !== 'coding' && (
          <div className='grid grid-cols-2 gap-4'>
            <div className='space-y-2'>
              <Label htmlFor='temperature'>Temperature</Label>
              <Input
                id='temperature'
                type='number'
                step='0.1'
                min='0'
                max='2'
                value={temperature}
                onChange={(e) => setTemperature(e.target.value)}
              />
            </div>
            <div className='space-y-2'>
              <Label htmlFor='maxTokens'>Max Tokens</Label>
              <Input
                id='maxTokens'
                type='number'
                min='1'
                value={maxTokens}
                onChange={(e) => setMaxTokens(e.target.value)}
              />
            </div>
          </div>
          )}

          {PROVIDER_DEFINITIONS[config.providerId]?.category !== 'coding' && (
            <ExtraParamsEditor rows={extraParams} onChange={setExtraParams} />
          )}

          {testResult && (
            <div
              className={`rounded-lg border p-3 text-sm ${
                testResult.success
                  ? 'border-green-200 bg-green-50 text-green-700'
                  : 'border-red-200 bg-red-50 text-red-700'
              }`}
            >
              <p className='font-medium'>{testResult.message}</p>
              {testResult.latencyMs > 0 && (
                <p className='mt-1 text-xs opacity-75'>
                  {t('connections.modelConfigLatency', { ms: testResult.latencyMs })}
                </p>
              )}
              {testResult.responsePreview && (
                <p className='mt-1 line-clamp-2 text-xs opacity-75'>{testResult.responsePreview}</p>
              )}
            </div>
          )}
        </div>

        <DialogFooter className='shrink-0 gap-2 sm:gap-0'>
          <Button variant='outline' onClick={handleTest} disabled={testing} className='mr-auto'>
            {testing && <Loader2 className='mr-2 h-4 w-4 animate-spin' />}
            {t('connections.modelConfigTestConnection')}
          </Button>
          <Button variant='outline' onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button onClick={handleSave} disabled={saving || !canSave}>
            {saving && <Loader2 className='mr-2 h-4 w-4 animate-spin' />}
            {t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
