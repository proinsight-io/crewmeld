'use client'

import { useEffect, useState } from 'react'

interface Props {
  employeeId: string
  config: Record<string, unknown>
  onUpdate: () => void
}

interface Model {
  id: string
  displayName: string
  modelName: string | null
}

interface OcrConnection {
  id: string
  name: string
  status: string
}

type OcrProvider = 'model' | 'baidu_ocr'

export function CustomerServiceSettings({ employeeId, config, onUpdate }: Props) {
  const [enabled, setEnabled] = useState(config.customerService === true)
  const [trackUnansweredQuestions, setTrackUnansweredQuestions] = useState(
    config.trackUnansweredQuestions === true
  )
  const [questions, setQuestions] = useState<Array<{ id: string; question: string; occurrenceCount: number; reason: string; lastSeenAt: string }>>([])
  const [questionTotal, setQuestionTotal] = useState(0)
  const [questionPage, setQuestionPage] = useState(1)
  const [greeting, setGreeting] = useState(
    typeof config.greeting === 'string' ? config.greeting : ''
  )
  const [ocrProvider, setOcrProvider] = useState<OcrProvider>(
    config.ocrProvider === 'baidu_ocr' ? 'baidu_ocr' : 'model'
  )
  const [ocrModelId, setOcrModelId] = useState(
    typeof config.ocrModelId === 'string' ? config.ocrModelId : ''
  )
  const [ocrConnectionId, setOcrConnectionId] = useState(
    typeof config.ocrConnectionId === 'string' ? config.ocrConnectionId : ''
  )
  const [ocrAllowedDomains, setOcrAllowedDomains] = useState(
    Array.isArray(config.ocrAllowedDomains)
      ? config.ocrAllowedDomains
          .filter((value): value is string => typeof value === 'string')
          .join('\n')
      : ''
  )
  const [models, setModels] = useState<Model[]>([])
  const [connections, setConnections] = useState<OcrConnection[]>([])
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')

  const updateUnansweredTracking = async (checked: boolean) => {
    setTrackUnansweredQuestions(checked)
    setQuestionPage(1)
    try {
      const response = await fetch(`/api/employee/employees/${employeeId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trackUnansweredQuestions: checked }),
      })
      if (!response.ok) throw new Error('保存未回答问题设置失败')
      onUpdate()
    } catch (error) {
      setTrackUnansweredQuestions(!checked)
      setMessage(error instanceof Error ? error.message : '保存未回答问题设置失败')
    }
  }

  useEffect(() => {
    Promise.all([
      fetch('/api/employee/models?activeOnly=true').then((response) => response.json()),
      fetch('/api/employee/connectors?type=baidu_ocr').then((response) => response.json()),
    ])
      .then(([modelPayload, connectionPayload]) => {
        setModels((modelPayload.data?.configs ?? modelPayload.data ?? []) as Model[])
        setConnections((connectionPayload.data?.connections ?? []) as OcrConnection[])
      })
      .catch(() => setMessage('加载 OCR 配置失败，请刷新后重试'))
  }, [])

  useEffect(() => {
    if (!trackUnansweredQuestions) return
    fetch(`/api/employee/employees/${employeeId}/unanswered-questions?page=${questionPage}&pageSize=10`)
      .then((response) => response.json())
      .then((payload) => {
        setQuestions(payload.data?.rows ?? [])
        setQuestionTotal(payload.data?.total ?? 0)
      })
      .catch(() => setMessage('加载未回答问题失败，请刷新后重试'))
  }, [employeeId, questionPage, trackUnansweredQuestions])

  const save = async () => {
    setSaving(true)
    setMessage('')
    try {
      const response = await fetch(`/api/employee/employees/${employeeId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerService: enabled,
          trackUnansweredQuestions,
          greeting: greeting || null,
          ocrProvider,
          ocrModelId: ocrProvider === 'model' ? ocrModelId || null : null,
          ocrConnectionId: ocrProvider === 'baidu_ocr' ? ocrConnectionId || null : null,
          ocrAllowedDomains: ocrAllowedDomains
            .split(/[,\n]/)
            .map((value) => value.trim())
            .filter(Boolean),
        }),
      })
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          error?: { message?: string }
          message?: string
        } | null
        throw new Error(payload?.error?.message ?? payload?.message ?? '保存失败')
      }
      setMessage('设置已保存')
      onUpdate()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className='grid max-w-6xl grid-cols-1 gap-6 xl:grid-cols-2'>
    <div className='space-y-5 rounded-lg border bg-white p-6'>
      <h2 className='font-semibold text-lg'>客服与多模态设置</h2>
      <label className='flex items-center gap-2 text-sm'>
        <input
          data-testid='employee-form:checkbox:customer-service'
          type='checkbox'
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
        />
        客服标记（仅查询知识库，不执行 SOP）
      </label>
      <label className='block space-y-1 text-sm'>
        <span>
          开场白（支持 {'{{user.name}}'}、{'{{user.email}}'} 等身份变量）
        </span>
        <textarea
          data-testid='employee-form:input:greeting'
          className='min-h-20 w-full rounded border p-2'
          value={greeting}
          onChange={(event) => setGreeting(event.target.value)}
        />
      </label>

      <fieldset className='space-y-3 rounded-md border p-4'>
        <legend className='px-1 font-medium text-sm'>图片与 PDF 识别方式</legend>
        <div className='flex flex-wrap gap-5 text-sm'>
          <label className='flex items-center gap-2'>
            <input
              type='radio'
              name='ocr-provider'
              checked={ocrProvider === 'model'}
              onChange={() => setOcrProvider('model')}
            />
            OCR 大模型
          </label>
          <label className='flex items-center gap-2'>
            <input
              type='radio'
              name='ocr-provider'
              checked={ocrProvider === 'baidu_ocr'}
              onChange={() => setOcrProvider('baidu_ocr')}
            />
            百度智能云 OCR
          </label>
        </div>

        {ocrProvider === 'model' ? (
          <label className='block space-y-1 text-sm'>
            <span>OCR 大模型</span>
            <select
              data-testid='employee-form:select:ocr-model'
              className='w-full rounded border p-2'
              value={ocrModelId}
              onChange={(event) => setOcrModelId(event.target.value)}
            >
              <option value=''>使用数字员工默认模型</option>
              {models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.displayName}
                  {model.modelName ? ` (${model.modelName})` : ''}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <label className='block space-y-1 text-sm'>
            <span>百度 OCR 连接</span>
            <select
              data-testid='employee-form:select:ocr-connection'
              className='w-full rounded border p-2'
              value={ocrConnectionId}
              onChange={(event) => setOcrConnectionId(event.target.value)}
            >
              <option value=''>请选择已配置的百度 OCR 连接</option>
              {connections.map((connection) => (
                <option key={connection.id} value={connection.id}>
                  {connection.name}（{connection.status === 'connected' ? '已连接' : '未连接'}）
                </option>
              ))}
            </select>
            {connections.length === 0 && (
              <span className='block text-amber-600 text-xs'>
                请先在“系统连接”中新增并测试百度智能云 OCR。
              </span>
            )}
          </label>
        )}
      </fieldset>

      <label className='block space-y-1 text-sm'>
        <span>OCR 链接域名白名单（可选）</span>
        <textarea
          data-testid='employee-form:input:ocr-allowed-domains'
          className='min-h-20 w-full rounded border p-2 font-mono text-xs'
          value={ocrAllowedDomains}
          onChange={(event) => setOcrAllowedDomains(event.target.value)}
          placeholder={'留空允许任意安全公网 HTTPS 地址；每行一个域名或 *.example.com'}
        />
      </label>

      {message && <p className='text-sm'>{message}</p>}
      <button
        data-testid='employee-form:submit:customer-service'
        type='button'
        disabled={saving}
        onClick={save}
        className='rounded bg-blue-600 px-4 py-2 text-white disabled:opacity-50'
      >
        {saving ? '保存中…' : '保存设置'}
      </button>
    </div>
    <section className='rounded-lg border bg-white p-6'>
      <h2 className='font-semibold text-lg'>AI 无法回答的问题</h2>
      <label className='mt-4 flex items-center gap-2 text-sm'>
        <input data-testid='employee-form:checkbox:track-unanswered-questions' type='checkbox' checked={trackUnansweredQuestions} onChange={(event) => void updateUnansweredTracking(event.target.checked)} />
        记录知识库未命中的用户问题
      </label>
      {!trackUnansweredQuestions ? <p className='mt-4 text-gray-500 text-sm'>开启后，将记录客服对话中知识库未找到答案的问题。</p> : (
        <div className='mt-5 overflow-x-auto'>
          {questions.length === 0 ? <p className='py-8 text-center text-gray-500 text-sm'>暂无未回答问题</p> : <table className='w-full text-left text-sm'><thead className='border-b text-gray-500'><tr><th className='pb-2 font-medium'>问题</th><th className='pb-2 font-medium'>次数</th><th className='pb-2 font-medium'>原因</th><th className='pb-2 font-medium'>最后出现</th></tr></thead><tbody>{questions.map((item) => <tr key={item.id} className='border-b last:border-0'><td className='max-w-52 py-3 pr-3'>{item.question}</td><td className='py-3 pr-3'>{item.occurrenceCount}</td><td className='py-3 pr-3'>{item.reason === 'low_similarity' ? '相似度不足' : '未检索到内容'}</td><td className='whitespace-nowrap py-3'>{new Date(item.lastSeenAt).toLocaleString()}</td></tr>)}</tbody></table>}
          <div className='mt-4 flex items-center justify-between text-sm'><span>共 {questionTotal} 条</span><div className='flex gap-2'><button type='button' className='rounded border px-3 py-1 disabled:opacity-50' disabled={questionPage === 1} onClick={() => setQuestionPage((page) => page - 1)}>上一页</button><button data-testid='unanswered-questions:button:next' type='button' className='rounded border px-3 py-1 disabled:opacity-50' disabled={questionPage * 10 >= questionTotal} onClick={() => setQuestionPage((page) => page + 1)}>下一页</button></div></div>
        </div>
      )}
    </section>
    </div>
  )
}
