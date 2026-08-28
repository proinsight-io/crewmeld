'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

interface QuestionGroup {
  id: string
  knowledgeBaseId: string | null
  canonicalQuestion: string
  answer: string | null
  occurrenceCount: number
  status: string
  promotedQaQuestionId: string | null
  firstSeenAt: string
  lastSeenAt: string
}

interface TopQuestion {
  id: string
  knowledgeBaseId: string
  question: string
  occurrenceCount: number
  lastSeenAt: string
  status: string
}

interface KnowledgeBaseOption {
  id: string
  ragflowId: string
  name: string
  type: 'document' | 'qa'
}

interface ApiPayload {
  data?: Record<string, unknown>
  error?: string
  message?: string
}

export function FrequentQuestionTable() {
  const [rows, setRows] = useState<QuestionGroup[]>([])
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBaseOption[]>([])
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [keyword, setKeyword] = useState('')
  const [knowledgeBaseId, setKnowledgeBaseId] = useState('')
  const [sort, setSort] = useState<'count' | 'recent'>('count')
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [topQuestions, setTopQuestions] = useState<TopQuestion[]>([])
  const [topLoading, setTopLoading] = useState(false)
  const [topError, setTopError] = useState<string | null>(null)
  const [lastMergeOperationId, setLastMergeOperationId] = useState<string | null>(null)
  const [promoting, setPromoting] = useState<QuestionGroup | null>(null)
  const [promotion, setPromotion] = useState({ question: '', answer: '', knowledgeBaseId: '' })
  const topRequestId = useRef(0)
  const pageSize = 20

  const qaKnowledgeBases = useMemo(
    () => knowledgeBases.filter((knowledgeBase) => knowledgeBase.type === 'qa'),
    [knowledgeBases]
  )
  const knowledgeName = useMemo(
    () => new Map(knowledgeBases.map((knowledgeBase) => [knowledgeBase.id, knowledgeBase.name])),
    [knowledgeBases]
  )

  const loadKnowledgeBases = useCallback(async () => {
    const response = await fetch('/api/employee/ragflow/datasets?pageSize=50')
    if (!response.ok) return
    const body = (await response.json()) as {
      data?: Array<{
        id: string
        name: string
        type?: 'document' | 'qa'
        metadata?: { id?: string; enabled?: boolean } | null
      }>
    }
    setKnowledgeBases(
      (body.data ?? []).flatMap((dataset) =>
        dataset.metadata?.id && dataset.metadata.enabled !== false
          ? [
              {
                id: dataset.metadata.id,
                ragflowId: dataset.id,
                name: dataset.name,
                type: dataset.type ?? 'document',
              },
            ]
          : []
      )
    )
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize), sort })
      if (keyword.trim()) params.set('keyword', keyword.trim())
      if (knowledgeBaseId) params.set('knowledgeBaseId', knowledgeBaseId)
      const response = await fetch(`/api/employee/knowledge/question-analytics?${params}`)
      const body = (await response.json()) as {
        success?: boolean
        data?: QuestionGroup[]
        error?: string
        pagination?: { total?: number }
      }
      if (!response.ok || !body.success) throw new Error(body.error || '加载高频问题失败')
      setRows(body.data ?? [])
      setTotal(body.pagination?.total ?? 0)
      setSelectedIds([])
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '加载高频问题失败')
    } finally {
      setLoading(false)
    }
  }, [knowledgeBaseId, keyword, page, sort])

  useEffect(() => {
    void loadKnowledgeBases()
  }, [loadKnowledgeBases])
  useEffect(() => {
    void load()
  }, [load])
  useEffect(() => {
    const requestId = ++topRequestId.current
    if (!knowledgeBaseId || knowledgeBaseId === 'other') {
      setTopQuestions([])
      setTopError(null)
      setTopLoading(false)
      return
    }

    const controller = new AbortController()
    let active = true
    setTopQuestions([])
    setTopError(null)
    setTopLoading(true)
    void (async () => {
      try {
        const response = await fetch(
          `/api/employee/knowledge/${knowledgeBaseId}/questions/top?topN=3`,
          { signal: controller.signal }
        )
        const body = (await response.json()) as {
          success?: boolean
          data?: TopQuestion[]
          error?: string
          message?: string
        }
        if (!response.ok || !body.success)
          throw new Error(body.error || body.message || '加载当前分类 Top 3 失败')
        if (!active || controller.signal.aborted || topRequestId.current !== requestId) return
        setTopQuestions(body.data ?? [])
      } catch (cause) {
        if (!active || controller.signal.aborted || topRequestId.current !== requestId) return
        setTopError(cause instanceof Error ? cause.message : '加载当前分类 Top 3 失败')
      } finally {
        if (active && !controller.signal.aborted && topRequestId.current === requestId)
          setTopLoading(false)
      }
    })()

    return () => {
      active = false
      controller.abort()
    }
  }, [knowledgeBaseId])

  const post = async (path: string, body: unknown) => {
    const response = await fetch(`/api/employee/knowledge/question-analytics/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const payload = (await response.json()) as ApiPayload
    if (!response.ok) throw new Error(payload.error || payload.message || '操作失败')
    return payload.data ?? {}
  }

  const classify = async (target: string) => {
    if (selectedIds.length === 0) return
    try {
      await post('batch-classify', {
        ids: selectedIds,
        knowledgeBaseId: target === 'other' ? null : target,
      })
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '批量归类失败')
    }
  }

  const merge = async () => {
    if (selectedIds.length < 2) return
    const first = rows.find((row) => row.id === selectedIds[0])
    const canonicalQuestion = window.prompt(
      '请输入合并后的标准问题',
      first?.canonicalQuestion ?? ''
    )
    if (!canonicalQuestion?.trim()) return
    try {
      const result = await post('merge', { ids: selectedIds, canonicalQuestion })
      setLastMergeOperationId(String(result.operationId))
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '合并失败')
    }
  }

  const unmerge = async () => {
    if (!lastMergeOperationId) return
    try {
      await post('unmerge', { operationId: lastMergeOperationId })
      setLastMergeOperationId(null)
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '撤销合并失败')
    }
  }

  const startPromote = (row: QuestionGroup) => {
    setPromoting(row)
    setPromotion({
      question: row.canonicalQuestion,
      answer: row.answer ?? '',
      knowledgeBaseId: qaKnowledgeBases[0]?.id ?? '',
    })
  }

  const promote = async () => {
    if (
      !promoting ||
      !promotion.question.trim() ||
      !promotion.answer.trim() ||
      !promotion.knowledgeBaseId
    )
      return
    try {
      await post('promote', { groupId: promoting.id, ...promotion })
      setPromoting(null)
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '加入问答库失败')
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  return (
    <section
      className='rounded-xl border border-gray-200 bg-white p-5'
      data-testid='knowledge:frequent-questions'
    >
      <div className='mb-4 flex flex-wrap items-center gap-2'>
        <Input
          className='w-64'
          value={keyword}
          placeholder='搜索用户问题'
          data-testid='knowledge:frequent:keyword'
          onChange={(event) => {
            setKeyword(event.target.value)
            setPage(1)
          }}
        />
        <select
          aria-label='高频问题分类'
          className='h-9 rounded-md border border-gray-200 bg-white px-3 text-sm'
          value={knowledgeBaseId}
          data-testid='knowledge:frequent:category'
          onChange={(event) => {
            setKnowledgeBaseId(event.target.value)
            setPage(1)
          }}
        >
          <option value=''>全部分类</option>
          <option value='other'>其他</option>
          {knowledgeBases.map((knowledgeBase) => (
            <option key={knowledgeBase.id} value={knowledgeBase.id}>
              {knowledgeBase.name}
            </option>
          ))}
        </select>
        <select
          className='h-9 rounded-md border border-gray-200 bg-white px-3 text-sm'
          value={sort}
          onChange={(event) => setSort(event.target.value === 'recent' ? 'recent' : 'count')}
        >
          <option value='count'>按出现次数</option>
          <option value='recent'>按最近出现</option>
        </select>
        <span className='text-gray-500 text-sm'>共 {total} 个问题组</span>
      </div>

      <div className='mb-4 flex flex-wrap items-center gap-2 rounded-lg bg-gray-50 p-3'>
        <span className='text-gray-600 text-sm'>已选 {selectedIds.length} 项</span>
        <select
          className='h-8 rounded border bg-white px-2 text-sm'
          defaultValue=''
          data-testid='knowledge:frequent:batch-classify'
          onChange={(event) => {
            if (event.target.value) void classify(event.target.value)
            event.target.value = ''
          }}
        >
          <option value=''>批量修改分类…</option>
          <option value='other'>其他</option>
          {knowledgeBases.map((knowledgeBase) => (
            <option key={knowledgeBase.id} value={knowledgeBase.id}>
              {knowledgeBase.name}
            </option>
          ))}
        </select>
        <Button
          size='sm'
          variant='outline'
          disabled={selectedIds.length < 2}
          onClick={() => void merge()}
        >
          合并问题
        </Button>
        {lastMergeOperationId && (
          <Button size='sm' variant='outline' onClick={() => void unmerge()}>
            撤销上次合并
          </Button>
        )}
      </div>

      {knowledgeBaseId && knowledgeBaseId !== 'other' && (
        <div className='mb-4 rounded-lg border border-blue-100 bg-blue-50/40 p-4'>
          <h3 className='font-medium text-gray-900'>当前分类 Top 3</h3>
          {topLoading && (
            <p role='status' aria-live='polite' className='mt-2 text-gray-500 text-sm'>
              加载中…
            </p>
          )}
          {topError && (
            <p role='alert' className='mt-2 text-red-700 text-sm'>
              {topError}
            </p>
          )}
          {!topLoading && !topError && topQuestions.length === 0 && (
            <p role='status' aria-live='polite' className='mt-2 text-gray-500 text-sm'>
              当前分类暂无高频问题
            </p>
          )}
          {!topLoading && !topError && topQuestions.length > 0 && (
            <ol className='mt-3 space-y-2'>
              {topQuestions.map((question, index) => (
                <li key={question.id} className='rounded bg-white p-3 text-sm shadow-sm'>
                  <p className='font-medium text-gray-900'>
                    {index + 1}. {question.question}
                  </p>
                  <p className='mt-1 text-gray-500'>
                    {question.occurrenceCount} 次 · 最近出现：
                    {new Date(question.lastSeenAt).toLocaleString()}
                  </p>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}

      {error && <p className='mb-3 rounded bg-red-50 p-2 text-red-700 text-sm'>{error}</p>}
      <div className='overflow-x-auto'>
        <table className='w-full min-w-[880px] text-left text-sm'>
          <thead>
            <tr className='border-b text-gray-500'>
              <th className='p-2'>选择</th>
              <th className='p-2'>标准问题</th>
              <th className='p-2'>分类</th>
              <th className='p-2'>次数</th>
              <th className='p-2'>最近出现</th>
              <th className='p-2'>状态</th>
              <th className='p-2'>操作</th>
            </tr>
          </thead>
          <tbody>
            {!loading &&
              rows.map((row) => (
                <tr key={row.id} className='border-b last:border-0'>
                  <td className='p-2'>
                    <input
                      type='checkbox'
                      aria-label={`选择问题：${row.canonicalQuestion}`}
                      checked={selectedIds.includes(row.id)}
                      onChange={() =>
                        setSelectedIds((ids) =>
                          ids.includes(row.id)
                            ? ids.filter((id) => id !== row.id)
                            : [...ids, row.id]
                        )
                      }
                    />
                  </td>
                  <td className='max-w-md p-2'>{row.canonicalQuestion}</td>
                  <td className='p-2'>
                    {row.knowledgeBaseId
                      ? (knowledgeName.get(row.knowledgeBaseId) ?? row.knowledgeBaseId)
                      : '其他'}
                  </td>
                  <td className='p-2 font-medium'>{row.occurrenceCount}</td>
                  <td className='p-2'>{new Date(row.lastSeenAt).toLocaleString()}</td>
                  <td className='p-2'>{row.status === 'promoted' ? '已加入问答库' : '待处理'}</td>
                  <td className='p-2'>
                    <Button
                      size='sm'
                      variant='outline'
                      disabled={qaKnowledgeBases.length === 0}
                      onClick={() => startPromote(row)}
                    >
                      填写答案并加入 QA
                    </Button>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
        {loading && <p className='p-6 text-center text-gray-500 text-sm'>加载中…</p>}
        {!loading && rows.length === 0 && (
          <p className='p-6 text-center text-gray-500 text-sm'>暂无用户问题</p>
        )}
      </div>

      <div className='mt-4 flex items-center justify-end gap-2 text-sm'>
        <Button
          size='sm'
          variant='outline'
          disabled={page <= 1}
          onClick={() => setPage((value) => value - 1)}
        >
          上一页
        </Button>
        <span>
          第 {page} / {totalPages} 页
        </span>
        <Button
          size='sm'
          variant='outline'
          disabled={page >= totalPages}
          onClick={() => setPage((value) => value + 1)}
        >
          下一页
        </Button>
      </div>

      {promoting && (
        <div className='mt-5 space-y-3 rounded-lg border border-blue-200 bg-blue-50/40 p-4'>
          <h3 className='font-medium'>填写答案并加入 QA 问答表</h3>
          <Input
            value={promotion.question}
            onChange={(event) =>
              setPromotion((value) => ({ ...value, question: event.target.value }))
            }
            placeholder='标准问题'
          />
          <textarea
            className='min-h-28 w-full rounded-md border border-gray-200 bg-white p-3 text-sm'
            value={promotion.answer}
            onChange={(event) =>
              setPromotion((value) => ({ ...value, answer: event.target.value }))
            }
            placeholder='答案'
          />
          <select
            className='h-9 w-full rounded-md border border-gray-200 bg-white px-3 text-sm'
            value={promotion.knowledgeBaseId}
            onChange={(event) =>
              setPromotion((value) => ({ ...value, knowledgeBaseId: event.target.value }))
            }
          >
            <option value=''>选择 QA 知识库</option>
            {qaKnowledgeBases.map((knowledgeBase) => (
              <option key={knowledgeBase.id} value={knowledgeBase.id}>
                {knowledgeBase.name}
              </option>
            ))}
          </select>
          <p className='text-gray-500 text-xs'>
            保存后进入问答表“待向量化”状态，不会立即上传 CSV。
          </p>
          <div className='flex justify-end gap-2'>
            <Button variant='outline' onClick={() => setPromoting(null)}>
              取消
            </Button>
            <Button onClick={() => void promote()}>保存到问答表</Button>
          </div>
        </div>
      )}
    </section>
  )
}
