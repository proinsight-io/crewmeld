'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  CheckCircle2,
  ChevronDown,
  Code2,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Play,
  PlugZap,
  Plus,
  Save,
  Trash2,
  X,
  XCircle,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { ConnectionType, DatabaseSubtype } from '@/lib/connectors/types'
import {
  CONNECTION_TYPE_I18N_KEYS,
  DATABASE_SUBTYPE_ICONS,
  DATABASE_SUBTYPE_LABELS,
} from '@/lib/connectors/types'
import { cn } from '@/lib/core/utils/cn'
import { useTranslation } from '@/hooks/use-translation'
import { checkSecurity } from '../security-check'
import type { SkillPackage } from '../types'
import { CONN_ENV_PREFIX, configKeyToEnvName, skillEnvName } from '../types'

interface ExecutionResult {
  success: boolean
  output?: unknown
  error?: string
}

/**
 * Format execution result as readable string
 * - If value is nested JSON string, auto-parse and indent
 */
function formatResultStr(result: unknown): string {
  if (result === null || result === undefined) return 'null'
  if (typeof result === 'string') return result

  function cleanValue(val: unknown): unknown {
    if (typeof val === 'string') {
      const trimmed = val.trim()
      if (
        (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
        (trimmed.startsWith('[') && trimmed.endsWith(']'))
      ) {
        try {
          return cleanValue(JSON.parse(trimmed))
        } catch {
          /* keep */
        }
      }
      return val
    }
    if (Array.isArray(val)) return val.map(cleanValue)
    if (val && typeof val === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(val)) out[k] = cleanValue(v)
      return out
    }
    return val
  }

  return JSON.stringify(cleanValue(result), null, 2) ?? 'null'
}

/** camelCase → UPPER_SNAKE_CASE: apiKey → API_KEY */
function camelToUpperSnake(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()
}

export interface AvailableConnection {
  id: string
  name: string
  type: string
  dbType?: string
  config: Record<string, unknown>
}

export function ToolEditor({
  skill,
  onClose,
  onSave,
  availableConnections,
}: {
  skill: SkillPackage
  onClose: () => void
  onSave: (updated: SkillPackage) => void
  /** Available connected systems list (for filtering by connectorType in instance editing) */
  availableConnections?: AvailableConnection[]
}) {
  const { t } = useTranslation()
  const [params, setParams] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {}
    if (skill.parameters?.properties) {
      for (const [key, prop] of Object.entries(skill.parameters.properties)) {
        // Secret params injected via env vars, not as input params
        if (prop.secret) continue
        // Connection-bound params (envName set) intentionally start empty so the
        // server's env-fill (e.g. CONN_HOST) wins. Preset values for these are
        // stale generation-time placeholders ("localhost", "3306", etc.) and
        // shouldn't shadow real connection config when the user hits Run.
        if (prop.envName) {
          initial[key] = ''
          continue
        }
        if (skill.presetParams?.[key] !== undefined && skill.presetParams[key] !== null) {
          initial[key] = String(skill.presetParams[key])
        } else {
          initial[key] = ''
        }
      }
    }
    return initial
  })

  // Env vars (secret params): init from skill.envVars, supplement missing ones
  const [envVars, setEnvVars] = useState<Array<{ name: string; value: string }>>(() => {
    const existing = skill.envVars && skill.envVars.length > 0 ? [...skill.envVars] : []
    const existingNames = new Set(existing.map((e) => e.name))
    // Extract secret params from parameters, supplement missing ones
    if (skill.parameters?.properties) {
      for (const [key, prop] of Object.entries(skill.parameters.properties)) {
        if (prop.secret) {
          const newName = skillEnvName(key)
          const oldName = camelToUpperSnake(key)
          // Backward compatible: only add when both old and new names absent
          if (!existingNames.has(newName) && !existingNames.has(oldName)) {
            // Try to get value from presetParams
            const presetVal = skill.presetParams?.[key] ?? ''
            existing.push({ name: newName, value: String(presetVal) })
          }
        }
      }
    }
    return existing
  })

  const [envVisible, setEnvVisible] = useState(false)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<ExecutionResult | null>(null)
  const resultRef = useRef<HTMLDivElement>(null)

  // Connection selector: only shown when template has connectorType and availableConnections provided
  const connTypeRaw = skill.connectorType
  const connType: { type: string; dbType?: string } | undefined = !connTypeRaw
    ? undefined
    : typeof connTypeRaw === 'string'
      ? { type: connTypeRaw }
      : connTypeRaw
  const filteredConnections = (availableConnections ?? []).filter((c) => {
    if (!connType) return false
    if (c.type !== connType.type) return false
    if (connType.dbType && c.dbType !== connType.dbType) return false
    return true
  })
  const hasConnSelector = !!connType && filteredConnections.length > 0
  const needsConnButNone = !!connType && filteredConnections.length === 0

  // Default: prefer connectionId, fallback to CONN_HOST reverse lookup
  const [selectedConnId, setSelectedConnId] = useState<string>(() => {
    if (!connType || filteredConnections.length === 0) return ''
    // Prefer connectionId saved on the skill
    if (skill.connectionId) {
      const match = filteredConnections.find((c) => c.id === skill.connectionId)
      if (match) return match.id
    }
    // Fallback: reverse lookup via CONN_HOST
    const connHost = envVars.find((e) => e.name === 'CONN_HOST')?.value
    if (connHost) {
      const match = filteredConnections.find((c) => String(c.config.host ?? '') === connHost)
      if (match) return match.id
    }
    return ''
  })
  const [connLoading, setConnLoading] = useState(false)
  const [connDropdownOpen, setConnDropdownOpen] = useState(false)
  const connDropdownRef = useRef<HTMLDivElement>(null)

  // After selecting connection, fill CONN_ env vars with config
  const handleSelectConnection = useCallback(async (connId: string) => {
    setSelectedConnId(connId)
    if (!connId) return
    setConnLoading(true)
    try {
      const res = await fetch(`/api/employee/connectors/config?ids=${connId}`)
      const data = await res.json()
      if (!data.success || !data.configs?.[0]) return
      const config = data.configs[0].config as Record<string, unknown>
      setEnvVars((prev) => {
        const nonConn = prev.filter((e) => !e.name.startsWith(CONN_ENV_PREFIX))
        const newConn: Array<{ name: string; value: string }> = []
        for (const [key, val] of Object.entries(config)) {
          if (val !== undefined && val !== null && String(val).trim()) {
            newConn.push({ name: configKeyToEnvName(key), value: String(val) })
          }
        }
        return [...nonConn, ...newConn]
      })
    } catch {
      /* ignore */
    } finally {
      setConnLoading(false)
    }
  }, [])

  // Close connection dropdown on outside click
  useEffect(() => {
    if (!connDropdownOpen) return
    const handler = (e: MouseEvent) => {
      if (connDropdownRef.current && !connDropdownRef.current.contains(e.target as Node)) {
        setConnDropdownOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [connDropdownOpen])

  // Non-CONN_ env vars (for UI display)
  const visibleEnvVars = hasConnSelector
    ? envVars.map((e, i) => ({ ...e, _idx: i })).filter((e) => !e.name.startsWith(CONN_ENV_PREFIX))
    : envVars.map((e, i) => ({ ...e, _idx: i }))

  const handleRun = useCallback(async () => {
    if (!skill.code) return

    // Must pass security check before running
    const paramNames = Object.keys(skill.parameters?.properties ?? {})
    const security = checkSecurity(skill.code, paramNames, skill.language ?? 'javascript')
    if (!security.passed) {
      setResult({
        success: false,
        error: t('skills.editorSecurityFailed', { errors: security.errors.join('\n') }),
      })
      return
    }

    setRunning(true)
    setResult(null)

    // Only forward params the user actually filled in. The form pre-fills empty
    // strings / "0" placeholders for untouched fields; sending those would shadow
    // env-injected defaults (e.g. CONN_HOST) on the server side.
    const execParams: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(params)) {
      const trimmed = typeof value === 'string' ? value.trim() : value
      if (trimmed === '' || trimmed === undefined || trimmed === null) continue
      const prop = skill.parameters?.properties?.[key]
      if (prop?.type === 'number') {
        const n = Number(trimmed)
        if (!Number.isFinite(n)) continue
        execParams[key] = n
      } else if (prop?.type === 'boolean') {
        execParams[key] = trimmed === 'true'
      } else {
        execParams[key] = trimmed
      }
    }

    // Convert env vars array to key-value object
    const envVarsMap: Record<string, string> = {}
    for (const e of envVars) {
      const nameStr = String(e.name ?? '').trim()
      const valueStr = String(e.value ?? '').trim()
      if (nameStr && valueStr) {
        envVarsMap[nameStr] = valueStr
      }
    }

    try {
      const res = await fetch('/api/employee/tools/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: skill.code,
          params: execParams,
          timeout: 30000,
          envVars: envVarsMap,
          language: skill.language ?? 'javascript',
          // Send schema + presets so the server can fill connection-bound params
          // (host/password/etc.) from process.env when the user form omits them.
          parameters: skill.parameters,
          presetParams: skill.presetParams,
          ...(selectedConnId ? { connectionId: selectedConnId } : {}),
        }),
      })
      const data = await res.json()
      if (data.success) {
        setResult({ success: true, output: data.output?.result })
      } else {
        setResult({ success: false, error: data.error || t('skills.editorExecFailed') })
      }
    } catch (err) {
      setResult({ success: false, error: err instanceof Error ? err.message : String(err) })
    } finally {
      setRunning(false)
      setTimeout(() => resultRef.current?.scrollIntoView({ behavior: 'smooth' }), 100)
    }
  }, [skill, params, envVars, selectedConnId])

  const handleSave = useCallback(() => {
    const validEnvVars = envVars.filter(
      (e) => String(e.name ?? '').trim() && String(e.value ?? '').trim()
    )
    onSave({
      ...skill,
      presetParams: { ...params },
      envVars: validEnvVars.length > 0 ? validEnvVars : undefined,
      connectionId: selectedConnId || null,
    })
  }, [skill, params, envVars, selectedConnId, onSave])

  // Only show non-secret params (secret params in env vars section)
  const visibleProperties = skill.parameters?.properties
    ? Object.entries(skill.parameters.properties).filter(([, prop]) => !prop.secret)
    : []
  const hasProperties = visibleProperties.length > 0

  return (
    <div
      className='fixed inset-0 z-50 flex items-center justify-center bg-black/40'
      onClick={onClose}
    >
      <div
        className='relative flex h-[80vh] w-[640px] max-w-[95vw] flex-col rounded-2xl bg-white shadow-2xl'
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className='flex items-center justify-between border-b px-6 py-4'>
          <div>
            <h2 className='font-semibold text-base text-gray-900'>{skill.name}</h2>
            <p className='text-gray-400 text-xs'>{skill.description}</p>
          </div>
          <button type='button' onClick={onClose} className='rounded-lg p-1.5 hover:bg-gray-100'>
            <X className='h-4 w-4 text-gray-400' />
          </button>
        </div>

        {/* Body */}
        <div className='flex-1 space-y-5 overflow-y-auto px-6 py-4'>
          {/* Empty state when no code */}
          {!skill.code && !hasProperties && (
            <div className='flex h-full flex-col items-center justify-center text-gray-400'>
              <Code2 className='mb-3 h-10 w-10' />
              <p className='font-medium text-sm'>{t('skills.editorNoParams')}</p>
              <p className='mt-1 text-xs'>{t('skills.editorNoParamsHint')}</p>
            </div>
          )}

          {/* Parameters */}
          {hasProperties && (
            <div className='space-y-3'>
              <p className='font-medium text-gray-700 text-sm'>{t('skills.editorInputParams')}</p>
              {visibleProperties.map(([key, prop]) => (
                <div key={key} className='space-y-1'>
                  <label
                    htmlFor={`skill-editor-param-${key}`}
                    className='flex items-center gap-1 font-medium text-gray-500 text-xs'
                  >
                    {key}
                    {skill.parameters!.required?.includes(key) && (
                      <span className='text-red-400'>*</span>
                    )}
                    <span className='ml-1 text-gray-300'>({prop.type})</span>
                  </label>
                  <p className='text-gray-400 text-xs'>{prop.description}</p>
                  {prop.type === 'boolean' ? (
                    <select
                      id={`skill-editor-param-${key}`}
                      value={params[key] || 'true'}
                      onChange={(e) => setParams((prev) => ({ ...prev, [key]: e.target.value }))}
                      className='w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-white focus:border-violet-400 focus:outline-none'
                      data-testid={`dialog:skill-editor:select:${key}`}
                    >
                      <option value='true'>true</option>
                      <option value='false'>false</option>
                    </select>
                  ) : (
                    <input
                      id={`skill-editor-param-${key}`}
                      type='text'
                      value={params[key] ?? ''}
                      onChange={(e) => setParams((prev) => ({ ...prev, [key]: e.target.value }))}
                      placeholder={t('skills.editorInputPlaceholder', { key })}
                      className='w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-white placeholder:text-gray-500 focus:border-violet-400 focus:outline-none'
                      data-testid={`dialog:skill-editor:input:${key}`}
                    />
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Env vars (secret params) config */}
          {skill.code && (
            <div className='space-y-3'>
              <div className='flex items-center justify-between'>
                <div className='flex items-center gap-1.5'>
                  <KeyRound className='h-4 w-4 text-amber-600' />
                  <p className='font-medium text-gray-700 text-sm'>{t('skills.editorEnvVars')}</p>
                  <button
                    type='button'
                    onClick={() => setEnvVisible((v) => !v)}
                    className='rounded p-0.5 text-gray-400 hover:text-gray-600'
                    title={envVisible ? t('skills.editorHideValue') : t('skills.editorShowValue')}
                    data-testid='dialog:skill-editor:button:toggle-env-visible'
                  >
                    {envVisible ? (
                      <EyeOff className='h-3.5 w-3.5' />
                    ) : (
                      <Eye className='h-3.5 w-3.5' />
                    )}
                  </button>
                </div>
                <button
                  type='button'
                  onClick={() => setEnvVars([...envVars, { name: '', value: '' }])}
                  className='flex items-center gap-1 rounded-md px-2 py-1 text-violet-600 text-xs hover:bg-violet-50'
                  data-testid='dialog:skill-editor:button:add-env'
                >
                  <Plus className='h-3 w-3' />
                  {t('skills.editorAdd')}
                </button>
              </div>

              {/* Connection dropdown - embedded in env vars section */}
              {hasConnSelector &&
                (() => {
                  const selectedConn = filteredConnections.find((c) => c.id === selectedConnId)
                  const dbIcon = connType!.dbType
                    ? (DATABASE_SUBTYPE_ICONS[connType!.dbType as DatabaseSubtype] ?? '🗄️')
                    : '🔗'
                  const dbLabel = connType!.dbType
                    ? (DATABASE_SUBTYPE_LABELS[connType!.dbType as DatabaseSubtype] ??
                      connType!.dbType)
                    : CONNECTION_TYPE_I18N_KEYS[connType!.type as ConnectionType]
                      ? t(CONNECTION_TYPE_I18N_KEYS[connType!.type as ConnectionType])
                      : connType!.type
                  return (
                    <div className='relative' ref={connDropdownRef}>
                      <div className='mb-1.5 flex items-center gap-2'>
                        <PlugZap className='h-3.5 w-3.5 text-blue-600' />
                        <span className='font-medium text-gray-600 text-xs'>
                          {t('skills.editorSystemConnection')}
                        </span>
                        <span className='rounded-full bg-blue-50 px-2 py-0.5 font-medium text-[10px] text-blue-600'>
                          {dbLabel}
                        </span>
                      </div>
                      <button
                        type='button'
                        onClick={() => setConnDropdownOpen((v) => !v)}
                        disabled={connLoading}
                        className={cn(
                          'flex w-full items-center gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-all',
                          selectedConn
                            ? 'border-blue-200 bg-gradient-to-r from-blue-50 to-white hover:border-blue-300'
                            : 'border-gray-200 bg-white hover:border-gray-300',
                          connLoading && 'cursor-not-allowed opacity-60',
                          connDropdownOpen && 'border-blue-300 ring-2 ring-blue-200'
                        )}
                        data-testid='dialog:skill-editor:select:connection'
                      >
                        <span className='text-base leading-none'>{dbIcon}</span>
                        <div className='min-w-0 flex-1'>
                          {connLoading ? (
                            <div className='flex items-center gap-1.5'>
                              <Loader2 className='h-3 w-3 animate-spin text-blue-500' />
                              <span className='text-blue-500 text-xs'>
                                {t('skills.editorLoadingConfig')}
                              </span>
                            </div>
                          ) : selectedConn ? (
                            <span className='block truncate font-medium text-gray-800 text-xs'>
                              {selectedConn.name}
                            </span>
                          ) : (
                            <span className='text-gray-400 text-xs'>
                              {t('skills.editorNoConnectionSelected', { label: dbLabel })}
                            </span>
                          )}
                        </div>
                        <ChevronDown
                          className={cn(
                            'h-3.5 w-3.5 text-gray-400 transition-transform',
                            connDropdownOpen && 'rotate-180'
                          )}
                        />
                      </button>

                      {/* Dropdown list */}
                      {connDropdownOpen && (
                        <div className='absolute top-full right-0 left-0 z-10 mt-1 overflow-hidden rounded-lg border border-gray-200 bg-white shadow-lg'>
                          <div className='max-h-48 overflow-y-auto py-1'>
                            {filteredConnections.map((c) => {
                              const isActive = c.id === selectedConnId
                              const icon = c.dbType
                                ? (DATABASE_SUBTYPE_ICONS[c.dbType as DatabaseSubtype] ?? '🗄️')
                                : '🔗'
                              return (
                                <button
                                  key={c.id}
                                  type='button'
                                  onClick={() => {
                                    handleSelectConnection(c.id)
                                    setConnDropdownOpen(false)
                                  }}
                                  className={cn(
                                    'flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-xs transition-colors',
                                    isActive ? 'bg-blue-50' : 'hover:bg-gray-50'
                                  )}
                                >
                                  <span className='text-base leading-none'>{icon}</span>
                                  <span
                                    className={cn(
                                      'flex-1 truncate',
                                      isActive ? 'font-semibold text-blue-700' : 'text-gray-700'
                                    )}
                                  >
                                    {c.name}
                                  </span>
                                  {isActive && (
                                    <CheckCircle2 className='h-3.5 w-3.5 shrink-0 text-blue-500' />
                                  )}
                                </button>
                              )
                            })}
                          </div>
                          <div className='border-gray-100 border-t px-3 py-1.5'>
                            <p className='text-[10px] text-gray-400'>
                              {t('skills.editorSwitchConnectionHint')}
                            </p>
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })()}

              {needsConnButNone && (
                <div className='rounded-lg border border-amber-200 bg-amber-50 px-3 py-2'>
                  <p className='text-amber-700 text-xs'>{t('skills.editorNoMatchingConn')}</p>
                  <a
                    href='/connections'
                    className='mt-1 inline-block font-medium text-blue-600 text-xs hover:underline'
                  >
                    {t('skills.editorGoToConnections')}
                  </a>
                </div>
              )}

              {!hasConnSelector && !needsConnButNone && (
                <p className='text-gray-400 text-xs'>{t('skills.editorEnvVarHint')}</p>
              )}

              {/* Non-CONN_ env vars */}
              {visibleEnvVars.map((entry) => (
                <div key={entry._idx} className='flex items-center gap-2'>
                  <input
                    type='text'
                    value={entry.name}
                    onChange={(e) => {
                      const next = [...envVars]
                      next[entry._idx] = {
                        name: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_'),
                        value: entry.value,
                      }
                      setEnvVars(next)
                    }}
                    placeholder={t('skills.editorEnvVarNamePlaceholder')}
                    className='w-40 rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 font-mono text-sm text-white placeholder:text-gray-500 focus:border-violet-400 focus:outline-none'
                    data-testid={`dialog:skill-editor:input:env-name:${entry._idx}`}
                  />
                  <input
                    type={envVisible ? 'text' : 'password'}
                    value={entry.value}
                    onChange={(e) => {
                      const next = [...envVars]
                      next[entry._idx] = { name: entry.name, value: e.target.value }
                      setEnvVars(next)
                    }}
                    placeholder={t('skills.editorEnvVarValuePlaceholder')}
                    className='flex-1 rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-white placeholder:text-gray-500 focus:border-violet-400 focus:outline-none'
                    data-testid={`dialog:skill-editor:input:env-value:${entry._idx}`}
                  />
                  <button
                    type='button'
                    onClick={() => setEnvVars(envVars.filter((_, i) => i !== entry._idx))}
                    className='shrink-0 rounded-lg p-2 text-red-400 hover:bg-red-900/30 hover:text-red-300'
                    data-testid={`dialog:skill-editor:button:remove-env:${entry._idx}`}
                  >
                    <Trash2 className='h-3.5 w-3.5' />
                  </button>
                </div>
              ))}
              {visibleEnvVars.length === 0 && !hasConnSelector && (
                <p className='py-2 text-center text-gray-500 text-xs'>
                  {t('skills.editorNoEnvVars')}
                </p>
              )}
            </div>
          )}

          {/* Code preview */}
          {skill.code && (
            <details className='group'>
              <summary className='flex cursor-pointer items-center gap-1.5 font-medium text-gray-500 text-sm hover:text-gray-700'>
                <Code2 className='h-4 w-4' />
                {t('skills.editorViewCode')}
                <ChevronDown className='h-3.5 w-3.5 transition-transform group-open:rotate-180' />
              </summary>
              <pre className='mt-2 max-h-56 overflow-auto rounded-lg bg-gray-900 p-3 text-gray-100 text-xs'>
                {skill.code}
              </pre>
            </details>
          )}

          {/* Execution result */}
          {result && (
            <div ref={resultRef} className='space-y-2'>
              <p className='font-medium text-gray-700 text-sm'>{t('skills.editorExecResult')}</p>
              <div
                className={cn(
                  'rounded-lg border p-4',
                  result.success ? 'border-green-200 bg-green-50' : 'border-red-200 bg-red-50'
                )}
              >
                <div className='mb-2 flex items-center gap-2'>
                  {result.success ? (
                    <>
                      <CheckCircle2 className='h-4 w-4 text-green-600' />
                      <span className='font-medium text-green-700 text-sm'>
                        {t('skills.editorExecSuccess')}
                      </span>
                    </>
                  ) : (
                    <>
                      <XCircle className='h-4 w-4 text-red-600' />
                      <span className='font-medium text-red-700 text-sm'>
                        {t('skills.editorExecFailed')}
                      </span>
                    </>
                  )}
                </div>
                <pre className='max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-white/60 p-3 text-gray-800 text-xs'>
                  {result.success ? formatResultStr(result.output) : result.error}
                </pre>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className='flex items-center justify-end gap-2 border-t px-6 py-3'>
          <Button variant='outline' size='sm' onClick={onClose}>
            {t('skills.editorCancel')}
          </Button>
          <Button
            size='sm'
            variant='outline'
            onClick={handleRun}
            disabled={running}
            data-testid='dialog:skill-editor:run'
          >
            {running ? (
              <>
                <Loader2 className='mr-1.5 h-3.5 w-3.5 animate-spin' />
                {t('skills.editorRunning')}
              </>
            ) : (
              <>
                <Play className='mr-1.5 h-3.5 w-3.5' />
                {t('skills.editorExecute')}
              </>
            )}
          </Button>
          <Button
            size='sm'
            className='bg-violet-600 hover:bg-violet-700'
            onClick={handleSave}
            data-testid='dialog:skill-editor:save'
          >
            <Save className='mr-1.5 h-3.5 w-3.5' />
            {t('skills.editorSavePreset')}
          </Button>
        </div>
      </div>
    </div>
  )
}
