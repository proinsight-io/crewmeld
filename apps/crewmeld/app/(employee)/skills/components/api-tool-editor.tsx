'use client'

/**
 * ApiToolEditor — three-stage (pre / request / post) API-tool create & edit dialog.
 *
 * Supports:
 * - Name, description, parameters (JSON Schema textarea)
 * - Pre-processing snippet with AI-generate shortcut
 * - HTTP request connection picker (custom_api connections)
 * - Post-processing snippet with AI-generate shortcut
 * - Inline test-run against the saved spec
 * - Save to the shared skills endpoint
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { CheckCircle2, Loader2, Play, Plus, Save, Sparkles, X, XCircle } from 'lucide-react'
import { nanoid } from 'nanoid'
import { Button } from '@/components/ui/button'
import { ToastPortal } from '@/components/ui/toast-portal'
import { useToast } from '@/hooks/use-toast'
import { cn } from '@/lib/core/utils/cn'
import type { ApiToolSpec } from '@/lib/tools/api-tool-types'
import type { SkillPackage } from '../types'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Available custom_api connection entry returned from /api/employee/connectors */
interface CustomApiConnection {
  id: string
  name: string
  type: string
}

interface TestRunResult {
  success: boolean
  result?: unknown
  error?: string
  stage?: string
}

/** Props for the editor dialog */
export interface ApiToolEditorProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called with the saved SkillPackage after a successful save */
  onSaved?: (skill: SkillPackage) => void
  /** When provided, opens in edit mode pre-populated with this tool */
  tool?: SkillPackage
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format an arbitrary result value as indented JSON for display */
function formatResult(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

/** Build a minimal initial parameters JSON Schema string */
const DEFAULT_PARAMS_JSON = JSON.stringify(
  { type: 'object', properties: {}, required: [] },
  null,
  2
)

// ---------------------------------------------------------------------------
// Inline AI-generate modal (lightweight one-shot prompt)
// ---------------------------------------------------------------------------

interface AiGenerateModalProps {
  stage: 'pre' | 'post'
  toolName: string
  toolDescription: string
  parametersJson: string
  onClose: () => void
  onApply: (code: string) => void
}

/**
 * Small modal that sends a one-shot request to the chat endpoint and
 * returns generated pre/post snippet code for the user to review and apply.
 */
function AiGenerateModal({
  stage,
  toolName,
  toolDescription,
  parametersJson,
  onClose,
  onApply,
}: AiGenerateModalProps) {
  const [prompt, setPrompt] = useState('')
  const [generatedCode, setGeneratedCode] = useState('')
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Auto-focus the prompt input on mount
  useEffect(() => {
    setTimeout(() => textareaRef.current?.focus(), 80)
  }, [])

  /** Build the system prompt for the AI */
  const buildSystemPrompt = (): string => {
    const stageLabel = stage === 'pre' ? '前处理 (pre)' : '后处理 (post)'
    const stageHint =
      stage === 'pre'
        ? '前处理函数从 scope.input 读取入参（scope.input 是运行时用户传入的参数对象），return 一个参数对象（可含 query / headers / body / pathParams）传给 HTTP 请求。还可用 ctx（ctx.callApi / ctx.callTool / ctx.log）。'
        : '后处理函数从 scope.response 读取 HTTP 响应（结构为 { status, statusText, headers, body }，body 在响应为 JSON 时已解析、否则为字符串），提取并处理后 return 最终结果。也可读 scope.input、用 ctx。'
    return [
      `你是一个 API 工具代码生成助手。`,
      `工具名称: ${toolName || '(未命名)'}`,
      `工具描述: ${toolDescription || '(无描述)'}`,
      `参数 Schema: ${parametersJson}`,
      ``,
      `请为该工具生成 ${stageLabel} 代码片段。`,
      stageHint,
      `代码必须是合法的 JavaScript 函数体，通过 scope.input / scope.response 访问数据（不要写裸 input / response，会 ReferenceError），可用 ctx 与 return；不得使用 require/import/eval/process/fs 等危险操作。`,
      `只返回代码内容，不要加任何 markdown 代码块标记或解释文字。`,
    ].join('\n')
  }

  const handleGenerate = useCallback(async () => {
    setGenerating(true)
    setError(null)
    setGeneratedCode('')
    try {
      // Fetch available models to pick one
      const modelsRes = await fetch('/api/employee/models?activeOnly=true')
      const modelsData = (await modelsRes.json()) as {
        success?: boolean
        data?: { configs?: Array<{ id: string }> }
      }
      const modelId = modelsData?.data?.configs?.[0]?.id ?? ''

      if (!modelId) {
        setError('未找到可用模型，请先在系统中配置大语言模型。')
        return
      }

      const systemPrompt = buildSystemPrompt()
      const userContent = prompt.trim() || `请生成 ${stage === 'pre' ? '前处理' : '后处理'} 代码。`

      const res = await fetch('/api/employee/tools/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          modelId,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContent },
          ],
        }),
      })

      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string }
        setError(data.error ?? `请求失败 (HTTP ${res.status})`)
        return
      }

      // Support both streaming (SSE) and non-streaming responses
      const contentType = res.headers.get('content-type') ?? ''
      if (contentType.includes('text/event-stream')) {
        const reader = res.body!.getReader()
        const decoder = new TextDecoder()
        let accumulated = ''
        let buffer = ''

        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''
          for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed.startsWith('data: ')) continue
            const data = trimmed.slice(6)
            if (data === '[DONE]') continue
            try {
              const parsed = JSON.parse(data) as {
                chunk?: string
                done?: boolean
                choices?: Array<{ delta?: { content?: string } }>
              }
              const chunk =
                parsed.chunk ?? parsed.choices?.[0]?.delta?.content ?? ''
              if (chunk) {
                accumulated += chunk
                setGeneratedCode(accumulated)
              }
              if (parsed.done) break
            } catch {
              /* skip */
            }
          }
        }
        setGeneratedCode(accumulated)
      } else {
        const data = (await res.json()) as { content?: string; chunk?: string }
        const raw = data.content ?? data.chunk ?? ''
        setGeneratedCode(typeof raw === 'string' ? raw : JSON.stringify(raw))
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setGenerating(false)
    }
  }, [prompt, stage, buildSystemPrompt])

  const stageLabel = stage === 'pre' ? '前处理' : '后处理'

  return (
    <div className='fixed inset-0 z-[60] flex items-center justify-center bg-black/50'>
      {/* Backdrop intentionally does not close on click to avoid discarding edits. */}
      <div className='relative flex w-[560px] max-w-[96vw] flex-col rounded-2xl bg-white shadow-2xl'>
        {/* Header */}
        <div className='flex items-center justify-between border-b px-5 py-4'>
          <div className='flex items-center gap-2'>
            <Sparkles className='h-4 w-4 text-violet-500' />
            <h3 className='font-semibold text-sm text-gray-900'>AI 生成 — {stageLabel}代码</h3>
          </div>
          <button
            type='button'
            onClick={onClose}
            className='rounded-lg p-1.5 hover:bg-gray-100'
          >
            <X className='h-4 w-4 text-gray-400' />
          </button>
        </div>

        {/* Body */}
        <div className='space-y-4 px-5 py-4'>
          <div>
            <label className='mb-1.5 block font-medium text-gray-600 text-xs'>
              补充要求（可选）
            </label>
            <textarea
              ref={textareaRef}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={`描述 ${stageLabel} 需要完成的具体操作，例如：提取 data.items 数组中的名称字段`}
              rows={3}
              className='w-full resize-none rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-800 placeholder:text-gray-400 focus:border-violet-400 focus:outline-none'
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  handleGenerate()
                }
              }}
            />
          </div>

          {error && (
            <div className='rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-red-700 text-xs'>
              {error}
            </div>
          )}

          {generatedCode && (
            <div>
              <label className='mb-1.5 block font-medium text-gray-600 text-xs'>生成结果</label>
              <textarea
                value={generatedCode}
                onChange={(e) => setGeneratedCode(e.target.value)}
                rows={10}
                className='w-full resize-y rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 font-mono text-gray-800 text-xs focus:border-violet-400 focus:outline-none'
              />
            </div>
          )}
        </div>

        {/* Footer */}
        <div className='flex items-center justify-end gap-2 border-t px-5 py-3'>
          <Button variant='outline' size='sm' onClick={onClose}>
            取消
          </Button>
          <Button
            size='sm'
            variant='outline'
            onClick={handleGenerate}
            disabled={generating}
          >
            {generating ? (
              <>
                <Loader2 className='mr-1.5 h-3.5 w-3.5 animate-spin' />
                生成中…
              </>
            ) : (
              <>
                <Sparkles className='mr-1.5 h-3.5 w-3.5' />
                {generatedCode ? '重新生成' : '生成'}
              </>
            )}
          </Button>
          {generatedCode && (
            <Button
              size='sm'
              className='bg-violet-600 hover:bg-violet-700'
              onClick={() => onApply(generatedCode)}
            >
              应用代码
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main editor component
// ---------------------------------------------------------------------------

/** Generate a stable tool id for new tools */
function newToolId(): string {
  return `api-tool-${nanoid(10)}`
}

/** Current date version string */
function currentVersion(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `V1.0.${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
}

export function ApiToolEditor({ open, onOpenChange, onSaved, tool }: ApiToolEditorProps) {
  // ---------------------------------------------------------------------------
  // Form state
  // ---------------------------------------------------------------------------
  const { toasts, showToast } = useToast()
  const [name, setName] = useState('')
  const [nameError, setNameError] = useState<string | null>(null)
  const [description, setDescription] = useState('')
  const [parametersJson, setParametersJson] = useState(DEFAULT_PARAMS_JSON)
  const [paramsError, setParamsError] = useState<string | null>(null)

  // Field refs — used to scroll + focus the first offending field on save.
  const nameRef = useRef<HTMLInputElement>(null)
  const paramsRef = useRef<HTMLTextAreaElement>(null)
  const connectionRef = useRef<HTMLSelectElement>(null)

  // Three-stage API spec fields
  const [preCode, setPreCode] = useState('')
  const [connectionId, setConnectionId] = useState('')
  const [connectionError, setConnectionError] = useState<string | null>(null)
  const [postCode, setPostCode] = useState('')

  // Test input
  const [testInputJson, setTestInputJson] = useState('{}')
  const [testInputError, setTestInputError] = useState<string | null>(null)

  // Connection list
  const [connections, setConnections] = useState<CustomApiConnection[]>([])
  const [connectionsLoading, setConnectionsLoading] = useState(false)

  // UI state
  const [saving, setSaving] = useState(false)
  const [testRunning, setTestRunning] = useState(false)
  const [testResult, setTestResult] = useState<TestRunResult | null>(null)
  const resultRef = useRef<HTMLDivElement>(null)

  // AI generate modal state
  const [aiModalStage, setAiModalStage] = useState<'pre' | 'post' | null>(null)

  // Stable tool id for new tools (persist across renders during create flow)
  const toolIdRef = useRef<string>(tool?.id ?? newToolId())

  // ---------------------------------------------------------------------------
  // Initialize from tool prop (edit mode)
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!open) return
    if (tool) {
      toolIdRef.current = tool.id
      setName(tool.name)
      setDescription(tool.description ?? '')
      setParametersJson(
        tool.parameters ? JSON.stringify(tool.parameters, null, 2) : DEFAULT_PARAMS_JSON
      )
      setPreCode(tool.apiSpec?.pre ?? '')
      setConnectionId(tool.apiSpec?.request?.connectionId ?? '')
      setPostCode(tool.apiSpec?.post ?? '')
    } else {
      // Reset for new tool
      toolIdRef.current = newToolId()
      setName('')
      setDescription('')
      setParametersJson(DEFAULT_PARAMS_JSON)
      setPreCode('')
      setConnectionId('')
      setPostCode('')
    }
    setParamsError(null)
    setNameError(null)
    setConnectionError(null)
    setTestResult(null)
    setTestInputJson('{}')
    setTestInputError(null)
  }, [open, tool])

  // ---------------------------------------------------------------------------
  // Load custom_api connections
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!open) return
    setConnectionsLoading(true)
    fetch('/api/employee/connectors?type=custom_api')
      .then((r) => r.json())
      .then((data: { success?: boolean; data?: { connections?: CustomApiConnection[] } }) => {
        const all = data?.data?.connections ?? []
        setConnections(all.filter((c) => c.type === 'custom_api'))
      })
      .catch(() => {})
      .finally(() => setConnectionsLoading(false))
  }, [open])

  // ---------------------------------------------------------------------------
  // Validate parameters JSON on blur
  // ---------------------------------------------------------------------------
  const handleParamsBlur = useCallback(() => {
    try {
      JSON.parse(parametersJson)
      setParamsError(null)
    } catch (err) {
      setParamsError(err instanceof Error ? err.message : '无效的 JSON')
    }
  }, [parametersJson])

  const handleTestInputBlur = useCallback(() => {
    try {
      JSON.parse(testInputJson)
      setTestInputError(null)
    } catch (err) {
      setTestInputError(err instanceof Error ? err.message : '无效的 JSON')
    }
  }, [testInputJson])

  // ---------------------------------------------------------------------------
  // Test run
  // ---------------------------------------------------------------------------
  const handleTestRun = useCallback(async () => {
    // Validate test input JSON before running
    let inputValue: unknown = {}
    try {
      inputValue = JSON.parse(testInputJson)
      setTestInputError(null)
    } catch (err) {
      setTestInputError(err instanceof Error ? err.message : '无效的 JSON')
      return
    }

    const apiSpec: ApiToolSpec = {
      pre: preCode,
      request: { connectionId },
      post: postCode,
    }

    setTestRunning(true)
    setTestResult(null)

    try {
      const res = await fetch('/api/employee/tools/api-tool/test-run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiSpec, input: inputValue }),
      })
      const data = (await res.json()) as TestRunResult
      setTestResult(data)
    } catch (err) {
      setTestResult({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setTestRunning(false)
      setTimeout(() => resultRef.current?.scrollIntoView({ behavior: 'smooth' }), 100)
    }
  }, [preCode, connectionId, postCode, testInputJson])

  // ---------------------------------------------------------------------------
  // Save
  // ---------------------------------------------------------------------------
  const handleSave = useCallback(async () => {
    // Field-level validation: surface the error under the offending field, then
    // scroll it into view + focus it. The save button lives in the always-visible
    // footer, so without this the user could click save while scrolled away from
    // the field that's actually wrong and never see the message.
    const focusField = (el: HTMLElement | null) => {
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      // Focus after the smooth scroll settles so it doesn't fight the animation.
      setTimeout(() => el?.focus(), 200)
    }

    // Clear stale field errors before re-validating.
    setNameError(null)
    setConnectionError(null)

    if (!name.trim()) {
      setNameError('工具名称不能为空。')
      focusField(nameRef.current)
      return
    }

    // Parse parameters JSON
    let parsedParameters: SkillPackage['parameters']
    try {
      parsedParameters = JSON.parse(parametersJson) as SkillPackage['parameters']
      setParamsError(null)
    } catch (err) {
      setParamsError(err instanceof Error ? err.message : '无效的 JSON')
      focusField(paramsRef.current)
      return
    }

    if (!connectionId) {
      setConnectionError('请选择一个 HTTP 连接。')
      focusField(connectionRef.current)
      return
    }

    setSaving(true)

    const skill: SkillPackage = {
      id: toolIdRef.current,
      name: name.trim(),
      description: description.trim(),
      version: tool?.version ?? currentVersion(),
      size: '0 KB',
      uploadedAt: new Date().toISOString().slice(0, 10),
      source: 'custom',
      category: tool?.category ?? 'API 工具',
      parameters: parsedParameters,
      kind: 'api',
      apiSpec: {
        pre: preCode,
        request: { connectionId },
        post: postCode,
      },
    }

    try {
      const res = await fetch('/api/employee/skills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skill }),
      })
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { message?: string }
        showToast(data.message ?? `保存失败 (HTTP ${res.status})`, { variant: 'error' })
        return
      }
      onSaved?.(skill)
      onOpenChange(false)
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), { variant: 'error' })
    } finally {
      setSaving(false)
    }
  }, [name, description, parametersJson, preCode, connectionId, postCode, tool, onSaved, onOpenChange, showToast])

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  if (!open) return null

  return (
    <>
      {/* Backdrop + dialog */}
      <div className='fixed inset-0 z-50 flex items-center justify-center bg-black/40'>
        {/* Backdrop intentionally does not close on click: clicking outside must
            not silently discard unsaved edits. Use the 取消 / X controls instead. */}
        <div className='relative flex h-[88vh] w-[720px] max-w-[96vw] flex-col rounded-2xl bg-white shadow-2xl'>
          {/* ── Header ─────────────────────────────────────────────────── */}
          <div className='flex shrink-0 items-center justify-between border-b px-6 py-4'>
            <div>
              <h2 className='font-semibold text-base text-gray-900'>
                {tool ? '编辑 API 工具' : '新建 API 工具'}
              </h2>
              <p className='text-gray-400 text-xs'>前处理 · 请求 · 后处理</p>
            </div>
            <button
              type='button'
              onClick={() => onOpenChange(false)}
              className='rounded-lg p-1.5 hover:bg-gray-100'
            >
              <X className='h-4 w-4 text-gray-400' />
            </button>
          </div>

          {/* ── Body (scrollable) ───────────────────────────────────────── */}
          <div className='flex-1 space-y-5 overflow-y-auto px-6 py-5'>

            {/* ── Basic info ── */}
            <div className='space-y-3'>
              <p className='font-medium text-gray-700 text-sm'>基本信息</p>

              {/* Name */}
              <div className='space-y-1'>
                <label
                  htmlFor='api-tool-editor-name'
                  className='font-medium text-gray-500 text-xs'
                >
                  工具名称 <span className='text-red-400'>*</span>
                </label>
                <input
                  id='api-tool-editor-name'
                  ref={nameRef}
                  type='text'
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value)
                    if (nameError) setNameError(null)
                  }}
                  placeholder='例如：查询天气'
                  className={cn(
                    'w-full rounded-lg border px-3 py-2 text-sm text-gray-800 placeholder:text-gray-400 focus:outline-none',
                    nameError
                      ? 'border-red-300 bg-red-50 focus:border-red-400'
                      : 'border-gray-200 focus:border-violet-400'
                  )}
                  data-testid='api-tool-editor:input:name'
                />
                {nameError && <p className='text-red-500 text-xs'>{nameError}</p>}
              </div>

              {/* Description */}
              <div className='space-y-1'>
                <label
                  htmlFor='api-tool-editor-desc'
                  className='font-medium text-gray-500 text-xs'
                >
                  描述
                </label>
                <input
                  id='api-tool-editor-desc'
                  type='text'
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder='简要描述工具的功能'
                  className='w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-800 placeholder:text-gray-400 focus:border-violet-400 focus:outline-none'
                  data-testid='api-tool-editor:input:description'
                />
              </div>

              {/* Parameters */}
              <div className='space-y-1'>
                <label
                  htmlFor='api-tool-editor-params'
                  className='font-medium text-gray-500 text-xs'
                >
                  参数 Schema（JSON Schema）
                </label>
                <textarea
                  id='api-tool-editor-params'
                  ref={paramsRef}
                  value={parametersJson}
                  onChange={(e) => setParametersJson(e.target.value)}
                  onBlur={handleParamsBlur}
                  rows={5}
                  className={cn(
                    'w-full resize-y rounded-lg border px-3 py-2 font-mono text-gray-800 text-xs focus:outline-none',
                    paramsError
                      ? 'border-red-300 bg-red-50 focus:border-red-400'
                      : 'border-gray-200 bg-gray-50 focus:border-violet-400'
                  )}
                  data-testid='api-tool-editor:textarea:parameters'
                  spellCheck={false}
                />
                {paramsError && (
                  <p className='text-red-500 text-xs'>{paramsError}</p>
                )}
              </div>
            </div>

            {/* ── Divider ── */}
            <hr className='border-gray-100' />

            {/* ── Stage 1: Pre ── */}
            <div className='space-y-2'>
              <div className='flex items-center justify-between'>
                <div>
                  <p className='font-medium text-gray-700 text-sm'>前处理</p>
                  <p className='text-gray-400 text-xs'>
                    接收 <code className='rounded bg-gray-100 px-1 text-[10px]'>scope.input</code> 和{' '}
                    <code className='rounded bg-gray-100 px-1 text-[10px]'>ctx</code>，
                    return 传给 HTTP 请求的参数对象
                  </p>
                </div>
                <Button
                  size='sm'
                  variant='outline'
                  onClick={() => setAiModalStage('pre')}
                  className='shrink-0 text-violet-600 border-violet-200 hover:bg-violet-50'
                >
                  <Sparkles className='mr-1.5 h-3.5 w-3.5' />
                  AI 生成
                </Button>
              </div>
              <textarea
                value={preCode}
                onChange={(e) => setPreCode(e.target.value)}
                rows={6}
                placeholder={'// 示例：\nconst { city } = scope.input;\nreturn { query: { city } };'}
                className='w-full resize-y rounded-lg border border-gray-200 bg-gray-900 px-3 py-2 font-mono text-gray-100 text-xs placeholder:text-gray-500 focus:border-violet-400 focus:outline-none'
                data-testid='api-tool-editor:code:pre'
                spellCheck={false}
              />
            </div>

            {/* ── Stage 2: Request (connection select) ── */}
            <div className='space-y-2'>
              <p className='font-medium text-gray-700 text-sm'>请求</p>
              <div className='space-y-1'>
                <label
                  htmlFor='api-tool-editor-connection'
                  className='font-medium text-gray-500 text-xs'
                >
                  HTTP 连接 <span className='text-red-400'>*</span>
                </label>
                {connectionsLoading ? (
                  <div className='flex items-center gap-2 text-gray-400 text-xs'>
                    <Loader2 className='h-3.5 w-3.5 animate-spin' />
                    加载连接中…
                  </div>
                ) : connections.length === 0 ? (
                  <div className='rounded-lg border border-amber-200 bg-amber-50 px-3 py-2'>
                    <p className='text-amber-700 text-xs'>
                      未找到 custom_api 类型的连接。
                    </p>
                    <a
                      href='/connections'
                      className='mt-1 inline-block font-medium text-blue-600 text-xs hover:underline'
                    >
                      前往系统连接页面添加
                    </a>
                  </div>
                ) : (
                  <select
                    id='api-tool-editor-connection'
                    ref={connectionRef}
                    value={connectionId}
                    onChange={(e) => {
                      setConnectionId(e.target.value)
                      if (connectionError) setConnectionError(null)
                    }}
                    className={cn(
                      'w-full rounded-lg border bg-white px-3 py-2 text-sm text-gray-800 focus:outline-none',
                      connectionError
                        ? 'border-red-300 bg-red-50 focus:border-red-400'
                        : 'border-gray-200 focus:border-violet-400'
                    )}
                    data-testid='api-tool-editor:select:connection'
                  >
                    <option value=''>— 请选择连接 —</option>
                    {connections.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                )}
                {connectionError && <p className='text-red-500 text-xs'>{connectionError}</p>}
              </div>
            </div>

            {/* ── Stage 3: Post ── */}
            <div className='space-y-2'>
              <div className='flex items-center justify-between'>
                <div>
                  <p className='font-medium text-gray-700 text-sm'>后处理</p>
                  <p className='text-gray-400 text-xs'>
                    接收 HTTP{' '}
                    <code className='rounded bg-gray-100 px-1 text-[10px]'>scope.response</code> 和{' '}
                    <code className='rounded bg-gray-100 px-1 text-[10px]'>ctx</code>，
                    return 最终输出结果
                  </p>
                </div>
                <Button
                  size='sm'
                  variant='outline'
                  onClick={() => setAiModalStage('post')}
                  className='shrink-0 text-violet-600 border-violet-200 hover:bg-violet-50'
                >
                  <Sparkles className='mr-1.5 h-3.5 w-3.5' />
                  AI 生成
                </Button>
              </div>
              <textarea
                value={postCode}
                onChange={(e) => setPostCode(e.target.value)}
                rows={6}
                placeholder={'// 示例：\nconst { body } = scope.response;\nreturn body.data;'}
                className='w-full resize-y rounded-lg border border-gray-200 bg-gray-900 px-3 py-2 font-mono text-gray-100 text-xs placeholder:text-gray-500 focus:border-violet-400 focus:outline-none'
                data-testid='api-tool-editor:code:post'
                spellCheck={false}
              />
            </div>

            {/* ── Divider ── */}
            <hr className='border-gray-100' />

            {/* ── Test run section ── */}
            <div className='space-y-3'>
              <p className='font-medium text-gray-700 text-sm'>测试运行</p>
              <div className='space-y-1'>
                <label
                  htmlFor='api-tool-editor-test-input'
                  className='font-medium text-gray-500 text-xs'
                >
                  测试输入（JSON）
                </label>
                <textarea
                  id='api-tool-editor-test-input'
                  value={testInputJson}
                  onChange={(e) => setTestInputJson(e.target.value)}
                  onBlur={handleTestInputBlur}
                  rows={3}
                  placeholder='{"city": "Beijing"}'
                  className={cn(
                    'w-full resize-y rounded-lg border px-3 py-2 font-mono text-gray-800 text-xs focus:outline-none',
                    testInputError
                      ? 'border-red-300 bg-red-50 focus:border-red-400'
                      : 'border-gray-200 bg-gray-50 focus:border-violet-400'
                  )}
                  data-testid='api-tool-editor:textarea:test-input'
                  spellCheck={false}
                />
                {testInputError && (
                  <p className='text-red-500 text-xs'>{testInputError}</p>
                )}
              </div>

              <Button
                size='sm'
                variant='outline'
                onClick={handleTestRun}
                disabled={testRunning}
                data-testid='api-tool-editor:button:test-run'
              >
                {testRunning ? (
                  <>
                    <Loader2 className='mr-1.5 h-3.5 w-3.5 animate-spin' />
                    运行中…
                  </>
                ) : (
                  <>
                    <Play className='mr-1.5 h-3.5 w-3.5' />
                    测试运行
                  </>
                )}
              </Button>

              {/* Test result */}
              {testResult && (
                <div ref={resultRef}>
                  <div
                    className={cn(
                      'rounded-lg border p-4',
                      testResult.success
                        ? 'border-green-200 bg-green-50'
                        : 'border-red-200 bg-red-50'
                    )}
                  >
                    <div className='mb-2 flex items-center gap-2'>
                      {testResult.success ? (
                        <>
                          <CheckCircle2 className='h-4 w-4 text-green-600' />
                          <span className='font-medium text-green-700 text-sm'>测试成功</span>
                        </>
                      ) : (
                        <>
                          <XCircle className='h-4 w-4 text-red-600' />
                          <span className='font-medium text-red-700 text-sm'>
                            测试失败
                            {testResult.stage ? ` (${testResult.stage} 阶段)` : ''}
                          </span>
                        </>
                      )}
                    </div>
                    <pre className='max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-white/60 p-3 text-gray-800 text-xs'>
                      {testResult.success
                        ? formatResult(testResult.result)
                        : testResult.error}
                    </pre>
                  </div>
                </div>
              )}
            </div>

          </div>

          {/* ── Footer ─────────────────────────────────────────────────── */}
          <div className='flex shrink-0 items-center justify-end gap-2 border-t px-6 py-3'>
            <Button variant='outline' size='sm' onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button
              size='sm'
              className='bg-violet-600 hover:bg-violet-700'
              onClick={handleSave}
              disabled={saving}
              data-testid='api-tool-editor:submit'
            >
              {saving ? (
                <>
                  <Loader2 className='mr-1.5 h-3.5 w-3.5 animate-spin' />
                  保存中…
                </>
              ) : (
                <>
                  <Save className='mr-1.5 h-3.5 w-3.5' />
                  保存
                </>
              )}
            </Button>
          </div>
        </div>
      </div>

      {/* AI Generate Modal */}
      {aiModalStage && (
        <AiGenerateModal
          stage={aiModalStage}
          toolName={name}
          toolDescription={description}
          parametersJson={parametersJson}
          onClose={() => setAiModalStage(null)}
          onApply={(code) => {
            if (aiModalStage === 'pre') setPreCode(code)
            else setPostCode(code)
            setAiModalStage(null)
          }}
        />
      )}

      <ToastPortal toasts={toasts} />
    </>
  )
}

// Re-export Plus icon for potential use from parent page when adding "New API Tool" button
export { Plus }
