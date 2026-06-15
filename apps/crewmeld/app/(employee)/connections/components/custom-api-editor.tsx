'use client'

import { useCallback, useRef, useState } from 'react'
import { ChevronDown, ClipboardPaste, Minus, PlayCircle, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { parseCurl } from '@/lib/connectors/curl-parser'
import { formatResponseBody } from '@/lib/connectors/format-response-body'
import { cn } from '@/lib/core/utils/cn'
import { useTranslation } from '@/hooks/use-translation'

// ── Types ──

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD'
export type AuthType = 'none' | 'api_key' | 'bearer' | 'basic'
export type BodyType = 'none' | 'json' | 'form-urlencoded' | 'raw'
type ConfigTab = 'params' | 'headers' | 'authorization' | 'body'

export interface KVRow {
  key: string
  value: string
  enabled: boolean
}

export interface CustomApiConfig {
  httpMethod: HttpMethod
  apiEndpoint: string
  params: KVRow[]
  customHeaders: KVRow[]
  authType: AuthType
  apiKey: string
  bearerToken: string
  basicUsername: string
  basicPassword: string
  bodyType: BodyType
  bodyContent: string
}

export interface TestResponse {
  status: number
  statusText: string
  latencyMs: number
  body: string
  headers: Record<string, string>
}

const HTTP_METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']

const METHOD_COLORS: Record<HttpMethod, string> = {
  GET: 'text-green-600',
  POST: 'text-orange-500',
  PUT: 'text-blue-600',
  PATCH: 'text-yellow-600',
  DELETE: 'text-red-500',
  HEAD: 'text-purple-500',
}

interface CustomApiEditorProps {
  value: CustomApiConfig
  onChange: (value: CustomApiConfig) => void
  /** Externally provided test response */
  testResponse?: TestResponse | null
  /** Whether currently testing */
  isTesting?: boolean
  /** Click to test */
  onSend?: () => void
  /** Compact mode (used when embedded in wizard) */
  compact?: boolean
}

function emptyRow(): KVRow {
  return { key: '', value: '', enabled: true }
}

export function getDefaultCustomApiConfig(): CustomApiConfig {
  return {
    httpMethod: 'GET',
    apiEndpoint: '',
    params: [emptyRow()],
    customHeaders: [emptyRow()],
    authType: 'none',
    apiKey: '',
    bearerToken: '',
    basicUsername: '',
    basicPassword: '',
    bodyType: 'none',
    bodyContent: '',
  }
}

/** Convert CustomApiConfig to flat config for storage */
export function customApiConfigToFlat(c: CustomApiConfig): Record<string, unknown> {
  return {
    httpMethod: c.httpMethod,
    apiEndpoint: c.apiEndpoint,
    params: c.params.filter((r) => r.key.trim()),
    customHeaders: c.customHeaders.filter((r) => r.key.trim()),
    authType: c.authType,
    apiKey: c.apiKey || undefined,
    bearerToken: c.bearerToken || undefined,
    basicUsername: c.basicUsername || undefined,
    basicPassword: c.basicPassword || undefined,
    bodyType: c.bodyType,
    bodyContent: c.bodyContent || undefined,
  }
}

/** Restore CustomApiConfig from flat config */
export function flatToCustomApiConfig(flat: Record<string, unknown>): CustomApiConfig {
  const rows = (arr: unknown): KVRow[] => {
    if (!Array.isArray(arr)) return [emptyRow()]
    const mapped = arr.map((r: Record<string, unknown>) => ({
      key: String(r.key ?? ''),
      value: String(r.value ?? ''),
      enabled: r.enabled !== false,
    }))
    return mapped.length > 0 ? mapped : [emptyRow()]
  }
  return {
    httpMethod: (flat.httpMethod as HttpMethod) || 'GET',
    apiEndpoint: String(flat.apiEndpoint ?? ''),
    params: rows(flat.params),
    customHeaders: rows(flat.customHeaders),
    authType: (flat.authType as AuthType) || 'none',
    apiKey: String(flat.apiKey ?? ''),
    bearerToken: String(flat.bearerToken ?? ''),
    basicUsername: String(flat.basicUsername ?? ''),
    basicPassword: String(flat.basicPassword ?? ''),
    bodyType: (flat.bodyType as BodyType) || 'none',
    bodyContent: String(flat.bodyContent ?? ''),
  }
}

export function CustomApiEditor({
  value,
  onChange,
  testResponse,
  isTesting,
  onSend,
  compact,
}: CustomApiEditorProps) {
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = useState<ConfigTab>('params')
  const [methodOpen, setMethodOpen] = useState(false)
  const [curlDialogOpen, setCurlDialogOpen] = useState(false)
  const [curlInput, setCurlInput] = useState('')
  const methodRef = useRef<HTMLDivElement>(null)

  const update = useCallback(
    (patch: Partial<CustomApiConfig>) => onChange({ ...value, ...patch }),
    [value, onChange]
  )

  // ── KV row helpers ──
  const updateRow = useCallback(
    (field: 'params' | 'customHeaders', index: number, patch: Partial<KVRow>) => {
      const rows = [...value[field]]
      rows[index] = { ...rows[index], ...patch }
      update({ [field]: rows })
    },
    [value, update]
  )

  const addRow = useCallback(
    (field: 'params' | 'customHeaders') => {
      update({ [field]: [...value[field], emptyRow()] })
    },
    [value, update]
  )

  const removeRow = useCallback(
    (field: 'params' | 'customHeaders', index: number) => {
      const rows = value[field].filter((_, i) => i !== index)
      update({ [field]: rows.length > 0 ? rows : [emptyRow()] })
    },
    [value, update]
  )

  // ── cURL import ──
  const handleImportCurl = useCallback(() => {
    if (!curlInput.trim()) return
    const parsed = parseCurl(curlInput)
    onChange({
      httpMethod: (HTTP_METHODS.includes(parsed.method as HttpMethod)
        ? parsed.method
        : 'GET') as HttpMethod,
      apiEndpoint: parsed.url,
      params: parsed.params.length > 0 ? parsed.params : [emptyRow()],
      customHeaders: parsed.headers.length > 0 ? parsed.headers : [emptyRow()],
      authType: parsed.authType,
      apiKey: '',
      bearerToken: parsed.bearerToken,
      basicUsername: parsed.basicUsername,
      basicPassword: parsed.basicPassword,
      bodyType: parsed.bodyType,
      bodyContent: parsed.bodyContent,
    })
    setCurlInput('')
    setCurlDialogOpen(false)
  }, [curlInput, onChange])

  const enabledParamsCount = value.params.filter((r) => r.enabled && r.key.trim()).length
  const enabledHeadersCount = value.customHeaders.filter((r) => r.enabled && r.key.trim()).length

  const tabs: Array<{ key: ConfigTab; label: string }> = [
    { key: 'params', label: `Params(${enabledParamsCount})` },
    { key: 'headers', label: `Headers(${enabledHeadersCount})` },
    { key: 'authorization', label: 'Authorization' },
    { key: 'body', label: `Body${value.bodyType !== 'none' ? '(1)' : '(0)'}` },
  ]

  return (
    <div className={cn('flex flex-col gap-3', compact && 'text-sm')}>
      {/* ── URL Bar ── */}
      <div className='flex items-center gap-2'>
        {/* Method selector */}
        <div className='relative' ref={methodRef}>
          <button
            type='button'
            data-testid='custom-api:select:method'
            onClick={() => setMethodOpen(!methodOpen)}
            className={cn(
              'flex h-9 items-center gap-1 rounded-lg border border-gray-300 bg-white px-3 font-semibold text-sm transition-colors hover:bg-gray-50',
              METHOD_COLORS[value.httpMethod]
            )}
          >
            {value.httpMethod}
            <ChevronDown className='h-3 w-3' />
          </button>
          {methodOpen && (
            <div className='absolute top-full left-0 z-10 mt-1 w-28 rounded-lg border border-gray-200 bg-white py-1 shadow-lg'>
              {HTTP_METHODS.map((m) => (
                <button
                  key={m}
                  data-testid={`custom-api:method:${m}`}
                  onClick={() => {
                    update({ httpMethod: m })
                    setMethodOpen(false)
                  }}
                  className={cn(
                    'block w-full px-3 py-1.5 text-left font-semibold text-sm transition-colors hover:bg-gray-100',
                    METHOD_COLORS[m],
                    value.httpMethod === m && 'bg-gray-50'
                  )}
                >
                  {m}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* URL input */}
        <Input
          data-testid='custom-api:input:url'
          className='flex-1'
          value={value.apiEndpoint}
          onChange={(e) => update({ apiEndpoint: e.target.value })}
          placeholder={t('connections.customApiUrlPlaceholder')}
        />

        {/* Send button */}
        {onSend && (
          <Button
            data-testid='custom-api:send'
            onClick={onSend}
            disabled={isTesting || !value.apiEndpoint.trim()}
            className='shrink-0 bg-blue-600 hover:bg-blue-700'
          >
            <PlayCircle className='mr-1 h-4 w-4' />
            {isTesting ? t('connections.customApiTesting') : t('connections.customApiTest')}
          </Button>
        )}

        {/* Import cURL */}
        <Button
          variant='outline'
          size='sm'
          data-testid='custom-api:import-curl'
          onClick={() => setCurlDialogOpen(true)}
          className='shrink-0 gap-1 text-xs'
        >
          <ClipboardPaste className='h-3.5 w-3.5' />
          {t('connections.customApiImportCurl')}
        </Button>
      </div>

      {/* ── Config Tabs ── */}
      <div className='flex border-gray-200 border-b'>
        {tabs.map((tab) => (
          <button
            key={tab.key}
            data-testid={`custom-api:tab:${tab.key}`}
            onClick={() => setActiveTab(tab.key)}
            className={cn(
              'px-4 py-2 font-medium text-sm transition-colors',
              activeTab === tab.key
                ? 'border-blue-600 border-b-2 text-blue-600'
                : 'text-gray-500 hover:text-gray-700'
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* ── Tab Content ── */}
      <div className='min-h-[120px] p-0.5'>
        {/* Params */}
        {activeTab === 'params' && (
          <KVEditor
            rows={value.params}
            onUpdateRow={(i, p) => updateRow('params', i, p)}
            onAddRow={() => addRow('params')}
            onRemoveRow={(i) => removeRow('params', i)}
            addLabel={t('connections.customApiAddParam')}
          />
        )}

        {/* Headers */}
        {activeTab === 'headers' && (
          <KVEditor
            rows={value.customHeaders}
            onUpdateRow={(i, p) => updateRow('customHeaders', i, p)}
            onAddRow={() => addRow('customHeaders')}
            onRemoveRow={(i) => removeRow('customHeaders', i)}
            addLabel={t('connections.customApiAddParam')}
          />
        )}

        {/* Authorization */}
        {activeTab === 'authorization' && (
          <div className='space-y-3'>
            <div>
              <label
                htmlFor='custom-api-auth-type'
                className='mb-1 block font-medium text-gray-600 text-xs'
              >
                {t('connections.customApiAuthType')}
              </label>
              <select
                id='custom-api-auth-type'
                data-testid='custom-api:select:auth-type'
                value={value.authType}
                onChange={(e) => update({ authType: e.target.value as AuthType })}
                className='w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500'
              >
                <option value='none'>{t('connections.customApiAuthNone')}</option>
                <option value='api_key'>{t('connections.customApiAuthApiKey')}</option>
                <option value='bearer'>{t('connections.customApiAuthBearer')}</option>
                <option value='basic'>{t('connections.customApiAuthBasic')}</option>
              </select>
            </div>
            {value.authType === 'api_key' && (
              <div>
                <label
                  htmlFor='custom-api-key'
                  className='mb-1 block font-medium text-gray-600 text-xs'
                >
                  API Key
                </label>
                <Input
                  id='custom-api-key'
                  data-testid='custom-api:input:api-key'
                  type='password'
                  value={value.apiKey}
                  onChange={(e) => update({ apiKey: e.target.value })}
                  placeholder={t('connections.customApiInputApiKey')}
                />
                <p className='mt-1 text-gray-400 text-xs'>
                  {t('connections.customApiAuthApiKeyHint')}
                </p>
              </div>
            )}
            {value.authType === 'bearer' && (
              <div>
                <label
                  htmlFor='custom-api-bearer-token'
                  className='mb-1 block font-medium text-gray-600 text-xs'
                >
                  Token
                </label>
                <Input
                  id='custom-api-bearer-token'
                  data-testid='custom-api:input:bearer-token'
                  type='password'
                  value={value.bearerToken}
                  onChange={(e) => update({ bearerToken: e.target.value })}
                  placeholder={t('connections.customApiInputBearer')}
                />
                <p className='mt-1 text-gray-400 text-xs'>
                  {t('connections.customApiAuthBearerHint')}
                </p>
              </div>
            )}
            {value.authType === 'basic' && (
              <div className='space-y-3'>
                <div>
                  <label
                    htmlFor='custom-api-basic-username'
                    className='mb-1 block font-medium text-gray-600 text-xs'
                  >
                    {t('connections.customApiUsername')}
                  </label>
                  <Input
                    id='custom-api-basic-username'
                    data-testid='custom-api:input:basic-username'
                    value={value.basicUsername}
                    onChange={(e) => update({ basicUsername: e.target.value })}
                    placeholder={t('connections.customApiUsername')}
                  />
                </div>
                <div>
                  <label
                    htmlFor='custom-api-basic-password'
                    className='mb-1 block font-medium text-gray-600 text-xs'
                  >
                    {t('connections.customApiPassword')}
                  </label>
                  <Input
                    id='custom-api-basic-password'
                    data-testid='custom-api:input:basic-password'
                    type='password'
                    value={value.basicPassword}
                    onChange={(e) => update({ basicPassword: e.target.value })}
                    placeholder={t('connections.customApiPassword')}
                  />
                </div>
              </div>
            )}
            {value.authType === 'none' && (
              <p className='py-4 text-center text-gray-400 text-xs'>
                {t('connections.customApiNoAuth')}
              </p>
            )}
          </div>
        )}

        {/* Body */}
        {activeTab === 'body' && (
          <div className='space-y-3'>
            <div className='flex items-center gap-4'>
              {(['none', 'json', 'form-urlencoded', 'raw'] as BodyType[]).map((bt) => {
                const labels: Record<BodyType, string> = {
                  none: 'none',
                  json: 'JSON',
                  'form-urlencoded': 'x-www-form-urlencoded',
                  raw: 'Raw',
                }
                return (
                  <label key={bt} className='flex items-center gap-1.5 text-sm'>
                    <input
                      type='radio'
                      name='bodyType'
                      data-testid={`custom-api:body-type:${bt}`}
                      checked={value.bodyType === bt}
                      onChange={() => update({ bodyType: bt })}
                      className='accent-blue-600'
                    />
                    {labels[bt]}
                  </label>
                )
              })}
            </div>
            {value.bodyType !== 'none' && (
              <textarea
                data-testid='custom-api:input:body'
                className='h-32 w-full rounded-lg border border-gray-300 bg-gray-50 p-3 font-mono text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500'
                value={value.bodyContent}
                onChange={(e) => update({ bodyContent: e.target.value })}
                placeholder={
                  value.bodyType === 'json'
                    ? '{"key": "value"}'
                    : value.bodyType === 'form-urlencoded'
                      ? 'key1=value1&key2=value2'
                      : t('connections.customApiBodyContent')
                }
              />
            )}
            {value.bodyType === 'none' && (
              <p className='py-4 text-center text-gray-400 text-xs'>
                {t('connections.customApiNoBody')}
              </p>
            )}
          </div>
        )}
      </div>

      {/* ── Response Area ── */}
      {(testResponse || isTesting) && (
        <div className='border-gray-200 border-t pt-3'>
          <h4 className='mb-2 font-semibold text-gray-700 text-sm'>
            {t('connections.customApiResponseTitle')}
          </h4>
          {isTesting && !testResponse && (
            <div className='flex items-center gap-2 py-4 text-gray-400 text-sm'>
              <div className='h-4 w-4 animate-spin rounded-full border-2 border-blue-600 border-t-transparent' />
              {t('connections.customApiRequestTesting')}
            </div>
          )}
          {testResponse && (
            <div className='space-y-2'>
              <div className='flex items-center gap-4 text-sm'>
                <span
                  className={cn(
                    'font-semibold',
                    testResponse.status >= 200 && testResponse.status < 300
                      ? 'text-green-600'
                      : testResponse.status >= 400
                        ? 'text-red-500'
                        : 'text-yellow-600'
                  )}
                >
                  {testResponse.status} {testResponse.statusText}
                </span>
                <span className='text-gray-400'>{testResponse.latencyMs}ms</span>
              </div>
              <pre className='max-h-48 overflow-y-auto whitespace-pre-wrap break-all rounded-lg bg-gray-900 p-3 text-green-400 text-xs'>
                {testResponse.body
                  ? formatResponseBody(testResponse.body)
                  : t('connections.customApiEmptyResponse')}
              </pre>
            </div>
          )}
        </div>
      )}

      {/* ── cURL Import Dialog ── */}
      {curlDialogOpen && (
        <div className='fixed inset-0 z-50 flex items-center justify-center bg-black/50'>
          <div className='w-full max-w-lg rounded-xl bg-white p-6 shadow-2xl'>
            <h3 className='mb-3 font-semibold text-gray-900 text-lg'>
              {t('connections.customApiImportCurlTitle')}
            </h3>
            <p className='mb-3 text-gray-500 text-sm'>{t('connections.customApiImportCurlDesc')}</p>
            <textarea
              data-testid='custom-api:input:curl'
              className='h-40 w-full rounded-lg border border-gray-300 bg-gray-50 p-3 font-mono text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500'
              value={curlInput}
              onChange={(e) => setCurlInput(e.target.value)}
              placeholder={`curl -X POST 'https://api.example.com/v1/data' \\\n  -H 'Content-Type: application/json' \\\n  -H 'Authorization: Bearer your-token' \\\n  -d '{"key": "value"}'`}
            />
            <div className='mt-4 flex justify-end gap-2'>
              <Button
                variant='outline'
                onClick={() => {
                  setCurlDialogOpen(false)
                  setCurlInput('')
                }}
              >
                {t('common.cancel')}
              </Button>
              <Button onClick={handleImportCurl} disabled={!curlInput.trim()}>
                {t('connections.customApiImportBtn')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── KV Editor Sub-component ──

interface KVEditorProps {
  rows: KVRow[]
  onUpdateRow: (index: number, patch: Partial<KVRow>) => void
  onAddRow: () => void
  onRemoveRow: (index: number) => void
  addLabel: string
}

function KVEditor({ rows, onUpdateRow, onAddRow, onRemoveRow, addLabel }: KVEditorProps) {
  return (
    <div className='space-y-0.5 px-0.5'>
      {/* Header */}
      <div className='grid grid-cols-[32px_1fr_1fr_32px] gap-2 px-1 font-medium text-gray-400 text-xs'>
        <span />
        <span>Key</span>
        <span>Value</span>
        <span />
      </div>
      {/* Rows */}
      {rows.map((row, i) => (
        <div key={i} className='grid grid-cols-[32px_1fr_1fr_32px] items-center gap-2 py-0.5'>
          <input
            type='checkbox'
            checked={row.enabled}
            onChange={(e) => onUpdateRow(i, { enabled: e.target.checked })}
            className='mx-auto accent-blue-600'
          />
          <Input
            className='h-8 text-sm'
            value={row.key}
            onChange={(e) => onUpdateRow(i, { key: e.target.value })}
            placeholder='Key'
          />
          <Input
            className='h-8 text-sm'
            value={row.value}
            onChange={(e) => onUpdateRow(i, { value: e.target.value })}
            placeholder='Value'
          />
          <button
            onClick={() => onRemoveRow(i)}
            className='flex h-7 w-7 items-center justify-center rounded text-gray-400 transition-colors hover:bg-red-50 hover:text-red-500'
          >
            <Minus className='h-3.5 w-3.5' />
          </button>
        </div>
      ))}
      {/* Add row button */}
      <button
        onClick={onAddRow}
        className='flex items-center gap-1 px-1 py-1 text-blue-600 text-xs transition-colors hover:text-blue-700'
      >
        <Plus className='h-3 w-3' />
        {addLabel}
      </button>
    </div>
  )
}
