'use client'

import { useCallback, useEffect, useState } from 'react'
import { Download, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'

type QaQuestion = {
  id: string
  question: string
  answer: string
  enabled: boolean
  version: number
  syncStatus?: string
  filename?: string | null
}

export function QaQuestionList({ knowledgeBaseId }: { knowledgeBaseId: string }) {
  const [rows, setRows] = useState<QaQuestion[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<QaQuestion | null>(null)
  const [draft, setDraft] = useState({ question: '', answer: '' })
  const [saving, setSaving] = useState(false)
  const [keyword, setKeyword] = useState('')
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const pageSize = 20

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const response = await fetch(
        `/api/employee/knowledge/${knowledgeBaseId}/questions?page=${page}&pageSize=${pageSize}&keyword=${encodeURIComponent(keyword)}`
      )
      const body = (await response.json()) as {
        success?: boolean
        data?: QaQuestion[]; pagination?: { total?: number }
        error?: string
      }
      if (!response.ok || !body.success) throw new Error(body.error ?? '加载问题失败')
      setRows(body.data ?? [])
      setTotal(body.pagination?.total ?? 0)
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '加载问题失败')
    } finally {
      setLoading(false)
    }
  }, [knowledgeBaseId, page, keyword])

  useEffect(() => {
    void load()
  }, [load])

  function startCreate() {
    setEditing({ id: '', question: '', answer: '', enabled: true, version: 0 })
    setDraft({ question: '', answer: '' })
  }

  function startEdit(row: QaQuestion) {
    setEditing(row)
    setDraft({ question: row.question, answer: row.answer })
  }

  async function save() {
    if (!draft.question.trim() || !draft.answer.trim()) return
    setSaving(true)
    try {
      const isNew = !editing?.id
      const response = await fetch(
        `/api/employee/knowledge/${knowledgeBaseId}/questions${isNew ? '' : `/${editing.id}`}`,
        {
          method: isNew ? 'POST' : 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(isNew ? draft : { ...draft, version: editing?.version }),
        }
      )
      const body = (await response.json()) as { success?: boolean; error?: string }
      if (!response.ok || !body.success) throw new Error(body.error ?? '保存失败')
      setEditing(null)
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  async function remove(row: QaQuestion) {
    if (!window.confirm(`确定删除“${row.question}”吗？`)) return
    const response = await fetch(`/api/employee/knowledge/${knowledgeBaseId}/questions/${row.id}`, {
      method: 'DELETE',
    })
    if (!response.ok) setError('删除失败')
    else await load()
  }

  function exportCsv() {
    window.open(
      `/api/employee/knowledge/${knowledgeBaseId}/questions/export`,
      '_blank',
      'noopener,noreferrer'
    )
  }

  async function submitVectorization() {
    const response = await fetch(`/api/employee/knowledge/${knowledgeBaseId}/questions/sync`, { method: 'POST' })
    if (!response.ok) setError('提交向量化失败')
    else await load()
  }

  return (
    <section
      className='mt-8 rounded-xl border border-gray-200 bg-white p-5'
      data-testid='knowledge:qa:questions'
    >
      <div className='mb-4 flex items-center gap-2'>
        <h2 className='font-semibold text-lg text-gray-900'>问题列表</h2>
        <span className='text-gray-500 text-sm'>({rows.length})</span>
        <div className='ml-auto flex gap-2'>
          <input className='rounded border px-2 text-sm' placeholder='检索问题/答案/文件名' value={keyword} onChange={(e) => { setKeyword(e.target.value); setPage(1) }} />
          <Button variant='outline' size='sm' onClick={() => void submitVectorization()}>提交向量化</Button>
          <Button variant='outline' size='sm' onClick={() => void load()}>
            <RefreshCw className='mr-1 h-4 w-4' />
            刷新
          </Button>
          <Button variant='outline' size='sm' onClick={exportCsv}>
            <Download className='mr-1 h-4 w-4' />
            导出 CSV
          </Button>
          <Button size='sm' onClick={startCreate}>
            <Plus className='mr-1 h-4 w-4' />
            新增问题
          </Button>
        </div>
      </div>
      {error && <p className='mb-3 rounded bg-red-50 p-2 text-red-700 text-sm'>{error}</p>}
      {loading ? (
        <p className='text-gray-500 text-sm'>加载中…</p>
      ) : rows.length === 0 ? (
        <p className='text-gray-500 text-sm'>暂无问题，请新增或导入 CSV。</p>
      ) : (
        <div className='overflow-x-auto'>
          <table className='w-full text-left text-sm'>
            <thead>
              <tr className='border-b text-gray-500'>
                <th className='p-2'>问题</th>
                <th className='p-2'>答案</th>
                <th className='p-2'>状态</th>
                <th className='p-2'>操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className='border-b last:border-0'>
                  <td className='max-w-xs p-2' title={row.filename ?? undefined}>{row.question}<div className='text-gray-400 text-xs'>{row.filename ?? '未提交文件'}</div></td>
                  <td className='max-w-md p-2'>{row.answer}</td>
                  <td className='p-2'>
                    {row.enabled ? '启用' : '停用'}
                    {row.syncStatus ? ` · ${row.syncStatus}` : ''}
                  </td>
                  <td className='p-2'>
                    <button
                      type='button'
                      className='mr-3 text-blue-600'
                      onClick={() => startEdit(row)}
                    >
                      编辑
                    </button>
                    <button type='button' className='text-red-600' onClick={() => void remove(row)}>
                      <Trash2 className='inline h-4 w-4' />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className='mt-3 flex items-center justify-end gap-2 text-sm'>
            <Button variant='outline' size='sm' disabled={page <= 1} onClick={() => setPage((v) => v - 1)}>上一页</Button>
            <span>第 {page} / {Math.max(1, Math.ceil(total / pageSize))} 页</span>
            <Button variant='outline' size='sm' disabled={page >= Math.ceil(total / pageSize)} onClick={() => setPage((v) => v + 1)}>下一页</Button>
          </div>
        </div>
      )}
      {editing && (
        <div className='mt-4 space-y-3 rounded-lg border bg-gray-50 p-4'>
          <input
            className='w-full rounded border p-2'
            placeholder='问题'
            value={draft.question}
            onChange={(event) => setDraft({ ...draft, question: event.target.value })}
          />
          <textarea
            className='w-full rounded border p-2'
            placeholder='答案'
            rows={4}
            value={draft.answer}
            onChange={(event) => setDraft({ ...draft, answer: event.target.value })}
          />
          <div className='flex justify-end gap-2'>
            <Button variant='outline' onClick={() => setEditing(null)}>
              取消
            </Button>
            <Button onClick={() => void save()} disabled={saving}>
              {saving ? '保存中…' : '保存'}
            </Button>
          </div>
        </div>
      )}
    </section>
  )
}
