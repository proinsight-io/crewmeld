'use client'

import { useCallback, useMemo, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/core/utils/cn'
import type { ProviderDisplayInfo } from '@/lib/models/types'
import { type TranslationKey, useTranslation } from '@/hooks/use-translation'
import { PROVIDER_DEFINITIONS } from '@/providers/models'

interface AddModelWizardProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  availableProviders: ProviderDisplayInfo[]
  existingConfigCounts: Record<string, number>
  onCreated: () => void
}

const CODING_DEFAULT_ENDPOINTS: Record<string, string> = {
  // Coding providers are driven by Claude Code in dev-studio, which speaks the
  // Anthropic Messages protocol — so these must be each vendor's
  // Anthropic-compatible endpoint (ending in /anthropic), NOT their OpenAI
  // (/v1, /compatible-mode/v1) endpoints.
  'kimi-coding': 'https://api.moonshot.cn/anthropic',
  'qianfan-coding': 'https://qianfan.baidubce.com/anthropic/coding',
  'qwen-coding': 'https://dashscope.aliyuncs.com/apps/anthropic',
  'claude-coding': 'https://api.anthropic.com/v1',
}

const PROVIDER_GROUP_IDS = [
  {
    key: 'domestic' as const,
    ids: ['qwen', 'deepseek', 'ernie', 'hunyuan', 'moonshot', 'zhipu', 'doubao', 'minimax'],
  },
  {
    key: 'international' as const,
    ids: [
      'openai',
      'anthropic',
      'google' /*, 'azure-openai', 'azure-anthropic', 'xai', 'mistral' */,
    ],
  },
  {
    key: 'coding' as const,
    ids: ['kimi-coding', 'qianfan-coding', 'qwen-coding', 'claude-coding'],
  },
  // Platform aggregator group is hidden for now
  // { key: 'platform' as const, ids: ['openrouter', 'groq', 'cerebras', 'bedrock', 'vertex'] },
  { key: 'local' as const, ids: ['ollama', 'vllm'] },
]

const PROVIDER_COLORS: Record<string, string> = {}

export function AddModelWizard({
  open,
  onOpenChange,
  availableProviders,
  existingConfigCounts,
  onCreated,
}: AddModelWizardProps) {
  const { t } = useTranslation()
  const providerGroups = useMemo(
    () => [
      { label: t('connections.modelGroupDomestic'), ids: PROVIDER_GROUP_IDS[0].ids },
      { label: t('connections.modelGroupInternational'), ids: PROVIDER_GROUP_IDS[1].ids },
      { label: t('connections.modelGroupCoding'), ids: PROVIDER_GROUP_IDS[2].ids },
      // { label: t('connections.modelGroupPlatform'), ids: ... }, // platform aggregators hidden for now
      { label: t('connections.modelGroupLocal'), ids: PROVIDER_GROUP_IDS[3].ids },
    ],
    [t]
  )
  const steps = useMemo(
    () => [t('connections.modelStepSelect'), t('connections.modelStepConfig')],
    [t]
  )
  const [step, setStep] = useState(1)
  const [selectedProvider, setSelectedProvider] = useState<ProviderDisplayInfo | null>(null)
  const [displayName, setDisplayName] = useState('')
  const [modelName, setModelName] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [apiEndpoint, setApiEndpoint] = useState('')
  const [temperature, setTemperature] = useState('0.7')
  const [maxTokens, setMaxTokens] = useState('4096')
  const [codingFastModel, setCodingFastModel] = useState('')
  const [codingSonnetModel, setCodingSonnetModel] = useState('')
  const [codingOpusModel, setCodingOpusModel] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const providerMap = new Map(availableProviders.map((p) => [p.id, p]))

  const reset = useCallback(() => {
    setStep(1)
    setSelectedProvider(null)
    setDisplayName('')
    setModelName('')
    setApiKey('')
    setApiEndpoint('')
    setTemperature('0.7')
    setMaxTokens('4096')
    setCodingFastModel('')
    setCodingSonnetModel('')
    setCodingOpusModel('')
    setSaving(false)
    setError(null)
  }, [])

  const handleClose = useCallback(() => {
    reset()
    onOpenChange(false)
  }, [reset, onOpenChange])

  const handleSelectProvider = useCallback((provider: ProviderDisplayInfo) => {
    setSelectedProvider(provider)
  }, [])

  const handleGoStep2 = useCallback(() => {
    if (!selectedProvider) return
    setDisplayName(selectedProvider.name)
    const def = PROVIDER_DEFINITIONS[selectedProvider.id]
    if (def?.category === 'coding') {
      setApiEndpoint(CODING_DEFAULT_ENDPOINTS[selectedProvider.id] ?? '')
      setModelName(def.defaultModel)
    }
    setStep(2)
  }, [selectedProvider])

  const handleSave = useCallback(async () => {
    if (!selectedProvider || !displayName.trim()) return
    setSaving(true)
    setError(null)
    try {
      // Claude coding: an empty endpoint falls back to the system default so
      // the dev-studio container always receives a concrete base URL.
      const effectiveEndpoint =
        selectedProvider.id === 'claude-coding' && !apiEndpoint.trim()
          ? CODING_DEFAULT_ENDPOINTS['claude-coding']
          : apiEndpoint
      const res = await fetch('/api/employee/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerId: selectedProvider.id,
          displayName: displayName.trim(),
          modelName: modelName.trim() || undefined,
          apiKey: apiKey || undefined,
          apiEndpoint: effectiveEndpoint || undefined,
          defaultParams: PROVIDER_DEFINITIONS[selectedProvider.id]?.category === 'coding'
            ? {
                ...(codingFastModel.trim() ? { codingFastModel: codingFastModel.trim() } : {}),
                ...(codingSonnetModel.trim() ? { codingSonnetModel: codingSonnetModel.trim() } : {}),
                ...(codingOpusModel.trim() ? { codingOpusModel: codingOpusModel.trim() } : {}),
              }
            : {
                temperature: Number.parseFloat(temperature),
                maxTokens: Number.parseInt(maxTokens, 10),
              },
        }),
      })
      const data = await res.json()
      if (data.success === false) {
        setError(data.error ?? t('connections.wizardSaveFailed'))
        return
      }
      handleClose()
      onCreated()
    } catch {
      setError(t('common.networkError'))
    } finally {
      setSaving(false)
    }
  }, [
    selectedProvider,
    displayName,
    modelName,
    apiKey,
    apiEndpoint,
    temperature,
    maxTokens,
    codingFastModel,
    codingSonnetModel,
    codingOpusModel,
    handleClose,
    onCreated,
    t,
  ])

  // Required-field validation applies only to coding-category providers.
  // Claude coding is exempt on the endpoint: an empty value falls back to the
  // system default in handleSave.
  const isCodingProvider = selectedProvider
    ? PROVIDER_DEFINITIONS[selectedProvider.id]?.category === 'coding'
    : false
  const isClaudeCoding = selectedProvider?.id === 'claude-coding'
  const canSave =
    !!displayName.trim() &&
    (!isCodingProvider ||
      (!!modelName.trim() && !!apiKey.trim() && (isClaudeCoding || !!apiEndpoint.trim())))
  const requiredMark = <span className='text-red-500'>*</span>

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) handleClose()
      }}
    >
      <DialogContent className='flex max-h-[85vh] max-w-2xl flex-col'>
        <DialogHeader className='shrink-0'>
          <DialogTitle>{t('connections.modelWizardTitle')}</DialogTitle>
        </DialogHeader>

        {/* Step indicator */}
        <div className='mb-4 flex shrink-0 items-center justify-center gap-2'>
          {steps.map((label, i) => {
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
                {s < steps.length && (
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

        {error && (
          <div className='mb-3 shrink-0 rounded-lg border border-red-200 bg-red-50 p-2 text-red-600 text-xs'>
            {error}
          </div>
        )}

        {/* Step 1: Select provider */}
        {step === 1 && (
          <div className='flex min-h-0 flex-1 flex-col gap-4'>
            <div className='flex-1 space-y-4 overflow-y-auto pr-1'>
              {providerGroups.map((group) => {
                const providers = group.ids
                  .map((id) => providerMap.get(id))
                  .filter((p): p is ProviderDisplayInfo => p !== undefined)
                if (providers.length === 0) return null
                return (
                  <div key={group.label}>
                    <h4 className='mb-2 font-medium text-gray-500 text-xs'>{group.label}</h4>
                    <div className='grid grid-cols-3 gap-2'>
                      {providers.map((provider) => {
                        const def = PROVIDER_DEFINITIONS[provider.id]
                        const Icon = def?.icon
                        const count = existingConfigCounts[provider.id] ?? 0
                        const isSelected = selectedProvider?.id === provider.id
                        return (
                          <button
                            key={provider.id}
                            onClick={() => handleSelectProvider(provider)}
                            className={cn(
                              'flex items-center gap-3 rounded-lg border p-3 text-left transition-all',
                              isSelected
                                ? 'border-blue-600 bg-blue-50'
                                : 'border-gray-200 hover:border-gray-300'
                            )}
                          >
                            {Icon ? (
                              <div className='flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gray-100'>
                                <Icon className='h-5 w-5' />
                              </div>
                            ) : (
                              <div
                                className={cn(
                                  'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg font-bold text-white text-xs',
                                  PROVIDER_COLORS[provider.id] ?? 'bg-gray-600'
                                )}
                              >
                                {(
                                  t(`connections.providerName_${provider.id}` as TranslationKey) ||
                                  provider.name
                                ).charAt(0)}
                              </div>
                            )}
                            <div className='min-w-0 flex-1'>
                              <span className='block font-medium text-gray-900 text-sm'>
                                {t(`connections.providerName_${provider.id}` as TranslationKey) ||
                                  provider.name}
                              </span>
                              {count > 0 && (
                                <span className='text-gray-400 text-xs'>
                                  {t('connections.modelExistingCount', { count })}
                                </span>
                              )}
                            </div>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )
              })}
            </div>
            <div className='flex justify-end pt-2'>
              <Button onClick={handleGoStep2} disabled={!selectedProvider}>
                {t('common.next')}
              </Button>
            </div>
          </div>
        )}

        {/* Step 2: Config form */}
        {step === 2 && selectedProvider && (
          <>
            <div className='-mr-2 flex-1 space-y-4 overflow-y-auto pr-2'>
            <div className='space-y-2'>
              <Label htmlFor='wiz-displayName'>
                {t('connections.modelDisplayName')} {isCodingProvider && requiredMark}
              </Label>
              <Input
                id='wiz-displayName'
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder={selectedProvider.name}
              />
            </div>

            <div className='space-y-2'>
              <Label htmlFor='wiz-modelName'>
                {t('connections.modelModelName')} {isCodingProvider && requiredMark}
              </Label>
              <Input
                id='wiz-modelName'
                value={modelName}
                onChange={(e) => setModelName(e.target.value)}
                placeholder={
                  selectedProvider.defaultModel || t('connections.modelModelNamePlaceholder')
                }
              />
              <p className='text-gray-400 text-xs'>{t('connections.modelModelNameHint')}</p>
            </div>

            <div className='space-y-2'>
              <Label htmlFor='wiz-apiKey'>
                API Key{' '}
                {isCodingProvider && requiredMark}
                {selectedProvider.id === 'ollama' && (
                  <span className='text-gray-400 text-xs'>
                    {t('connections.modelApiKeyOptional')}
                  </span>
                )}
              </Label>
              <Input
                id='wiz-apiKey'
                type='password'
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={t('connections.modelApiKeyPlaceholder')}
              />
            </div>

            <div className='space-y-2'>
              <Label htmlFor='wiz-apiEndpoint'>
                {t('connections.modelEndpointLabel')}{' '}
                {isCodingProvider && !isClaudeCoding ? (
                  requiredMark
                ) : (
                  <span className='text-gray-400 text-xs'>
                    {t('connections.modelEndpointOptional')}
                  </span>
                )}
              </Label>
              <Input
                id='wiz-apiEndpoint'
                value={apiEndpoint}
                onChange={(e) => setApiEndpoint(e.target.value)}
                placeholder={
                  selectedProvider.id === 'ollama'
                    ? 'http://localhost:11434'
                    : selectedProvider.id === 'openai'
                      ? 'https://dashscope.aliyuncs.com/compatible-mode/v1'
                      : selectedProvider.id === 'anthropic'
                        ? 'https://api.deepseek.com/anthropic'
                        : 'https://api.example.com'
                }
              />
              {selectedProvider.id === 'openai' && (
                <p className='text-gray-400 text-xs'>{t('connections.modelEndpointOpenAIHint')}</p>
              )}
              {selectedProvider.id === 'anthropic' && (
                <p className='text-gray-400 text-xs'>
                  {t('connections.modelEndpointAnthropicHint')}
                </p>
              )}
              {isClaudeCoding && (
                <p className='text-gray-400 text-xs'>
                  {t('connections.modelEndpointClaudeDefaultHint')}
                </p>
              )}
            </div>

            {PROVIDER_DEFINITIONS[selectedProvider.id]?.category === 'coding' && (
              <div className='space-y-4'>
                <div className='space-y-2'>
                  <Label htmlFor='wiz-codingFast'>
                    {t('connections.modelCodingFast')}{' '}
                    <span className='text-gray-400 text-xs'>
                      {t('connections.modelCodingTierOptional')}
                    </span>
                  </Label>
                  <Input
                    id='wiz-codingFast'
                    value={codingFastModel}
                    onChange={(e) => setCodingFastModel(e.target.value)}
                    placeholder={modelName || selectedProvider.defaultModel}
                  />
                </div>
                <div className='space-y-2'>
                  <Label htmlFor='wiz-codingSonnet'>
                    {t('connections.modelCodingSonnet')}{' '}
                    <span className='text-gray-400 text-xs'>
                      {t('connections.modelCodingTierOptional')}
                    </span>
                  </Label>
                  <Input
                    id='wiz-codingSonnet'
                    value={codingSonnetModel}
                    onChange={(e) => setCodingSonnetModel(e.target.value)}
                    placeholder={modelName || selectedProvider.defaultModel}
                  />
                </div>
                <div className='space-y-2'>
                  <Label htmlFor='wiz-codingOpus'>
                    {t('connections.modelCodingOpus')}{' '}
                    <span className='text-gray-400 text-xs'>
                      {t('connections.modelCodingTierOptional')}
                    </span>
                  </Label>
                  <Input
                    id='wiz-codingOpus'
                    value={codingOpusModel}
                    onChange={(e) => setCodingOpusModel(e.target.value)}
                    placeholder={modelName || selectedProvider.defaultModel}
                  />
                </div>
              </div>
            )}

            {PROVIDER_DEFINITIONS[selectedProvider.id]?.category !== 'coding' && (
            <div className='grid grid-cols-2 gap-4'>
              <div className='space-y-2'>
                <Label htmlFor='wiz-temperature'>Temperature</Label>
                <Input
                  id='wiz-temperature'
                  type='number'
                  step='0.1'
                  min='0'
                  max='2'
                  value={temperature}
                  onChange={(e) => setTemperature(e.target.value)}
                />
              </div>
              <div className='space-y-2'>
                <Label htmlFor='wiz-maxTokens'>Max Tokens</Label>
                <Input
                  id='wiz-maxTokens'
                  type='number'
                  min='1'
                  value={maxTokens}
                  onChange={(e) => setMaxTokens(e.target.value)}
                />
              </div>
            </div>
            )}

            </div>

            <div className='flex shrink-0 justify-between pt-2'>
              <Button variant='outline' onClick={() => setStep(1)}>
                {t('common.previous')}
              </Button>
              <Button onClick={handleSave} disabled={saving || !canSave}>
                {saving && <Loader2 className='mr-2 h-4 w-4 animate-spin' />}
                {t('common.save')}
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
