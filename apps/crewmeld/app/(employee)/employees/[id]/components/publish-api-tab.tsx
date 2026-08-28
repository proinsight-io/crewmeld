'use client'

import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'

interface UserOption {
  id: string
  name?: string
  email?: string
  active?: boolean
}

interface ApiKey {
  id: string
  name: string
  keyPrefix: string
  userId: string | null
  allowedSupportUserIds: string[]
  allowedOrigins: string[]
  active: boolean
  createdAt: string
  lastUsedAt: string | null
}

interface KeyDraft {
  name: string
  userId: string
  active: boolean
  allowedSupportUserIds: string[]
  allowedOriginsText: string
}

export function PublishApiTab({ employeeId }: { employeeId: string }) {
  const [users, setUsers] = useState<UserOption[]>([])
  const [keys, setKeys] = useState<ApiKey[]>([])
  const [drafts, setDrafts] = useState<Record<string, KeyDraft>>({})
  const [name, setName] = useState('')
  const [identity, setIdentity] = useState('')
  const [supportSearch, setSupportSearch] = useState<Record<string, string>>({})
  const [created, setCreated] = useState<string | null>(null)
  const [testKey, setTestKey] = useState('')
  const [testResult, setTestResult] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const activeUsers = useMemo(() => users.filter((user) => user.active !== false), [users])
  const label = (user: UserOption) =>
    `${user.name ?? user.id}${user.email ? ` (${user.email})` : ''}`

  const load = async () => {
    const [keysResponse, usersResponse] = await Promise.all([
      fetch(`/api/employee/employees/${employeeId}/api-keys`),
      fetch('/api/employee/users'),
    ])
    if (keysResponse.ok) {
      const data = (await keysResponse.json()) as { keys?: ApiKey[] }
      const next = data.keys ?? []
      setKeys(next)
      setDrafts(
        Object.fromEntries(
          next.map((key) => [
            key.id,
            {
              name: key.name,
              userId: key.userId ?? '',
              active: key.active,
              allowedSupportUserIds: key.allowedSupportUserIds ?? [],
              allowedOriginsText: (key.allowedOrigins ?? []).join('\n'),
            },
          ])
        )
      )
    }
    if (usersResponse.ok) {
      const data = (await usersResponse.json()) as { users?: UserOption[]; data?: UserOption[] }
      setUsers(data.users ?? data.data ?? [])
    }
  }

  useEffect(() => {
    void load()
  }, [employeeId])

  const create = async () => {
    setMessage(null)
    const response = await fetch(`/api/employee/employees/${employeeId}/api-keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, userId: identity }),
    })
    const data = (await response.json()) as { key?: string; error?: string }
    if (!response.ok) {
      setMessage(data.error || '创建 API Key 失败')
      return
    }
    setCreated(data.key ?? null)
    setTestKey(data.key ?? '')
    setName('')
    setIdentity('')
    setMessage('API Key 已创建，请立即保存完整密钥。')
    await load()
  }

  const save = async (keyId: string) => {
    const draft = drafts[keyId]
    if (!draft?.name.trim() || !draft.userId) return
    setMessage(null)
    const response = await fetch(`/api/employee/employees/${employeeId}/api-keys/${keyId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: draft.name.trim(),
        userId: draft.userId,
        active: draft.active,
        allowedSupportUserIds: draft.allowedSupportUserIds,
        allowedOrigins: draft.allowedOriginsText
          .split(/[,\n]/)
          .map((value) => value.trim())
          .filter(Boolean),
      }),
    })
    const data = (await response.json()) as { error?: string; code?: string }
    setMessage(response.ok ? 'API Key 设置已保存' : data.error || data.code || '保存失败')
    if (response.ok) await load()
  }

  const remove = async (key: ApiKey) => {
    if (!window.confirm(`确定删除 API Key“${key.name}”吗？删除后无法恢复。`)) return
    const response = await fetch(`/api/employee/employees/${employeeId}/api-keys/${key.id}`, {
      method: 'DELETE',
    })
    setMessage(response.ok ? 'API Key 已删除' : '删除失败')
    if (response.ok) await load()
  }

  const test = async () => {
    setTestResult('测试中…')
    const response = await fetch(`/api/public/employees/${employeeId}/status`, {
      headers: { 'X-API-Key': testKey.trim() },
    })
    setTestResult(response.ok ? '连接成功：API Key 有效' : `连接失败：HTTP ${response.status}`)
  }

  const updateDraft = (keyId: string, patch: Partial<KeyDraft>) => {
    setDrafts((current) => ({ ...current, [keyId]: { ...current[keyId], ...patch } }))
  }

  return (
    <div className='space-y-5' data-testid='employee-publish-api:container'>
      <div>
        <h2 className='font-semibold text-gray-900 text-lg'>数字员工 API 发布</h2>
        <p className='text-gray-500 text-sm'>
          将该数字员工的完整会话能力发布为 API，不依赖工具绑定。
        </p>
      </div>

      {message && <p className='rounded-md bg-blue-50 p-3 text-blue-700 text-sm'>{message}</p>}

      <div className='rounded border bg-white p-4'>
        <h3 className='font-medium'>创建 API Key</h3>
        <div className='mt-3 flex flex-wrap gap-2'>
          <input
            className='rounded border px-2 py-1 text-sm'
            placeholder='Key 名称'
            value={name}
            onChange={(event) => setName(event.target.value)}
            data-testid='employee-publish-api:input:name'
          />
          <select
            className='min-w-64 rounded border px-2 py-1 text-sm'
            value={identity}
            onChange={(event) => setIdentity(event.target.value)}
            data-testid='employee-publish-api:select:identity'
          >
            <option value=''>选择 API 身份用户（必选）</option>
            {activeUsers.map((user) => (
              <option key={user.id} value={user.id}>
                {label(user)}
              </option>
            ))}
          </select>
          <Button disabled={!name.trim() || !identity} onClick={() => void create()}>
            创建
          </Button>
        </div>
        {created && (
          <p className='mt-2 break-all rounded bg-yellow-50 p-2 font-mono text-xs'>
            请立即保存此 Key：{created}
          </p>
        )}
      </div>

      <div className='rounded border bg-white p-4'>
        <h3 className='font-medium'>API Key 测试</h3>
        <div className='mt-3 flex gap-2'>
          <input
            type='password'
            className='min-w-80 flex-1 rounded border px-2 py-1 text-sm'
            placeholder='粘贴完整 API Key'
            value={testKey}
            onChange={(event) => setTestKey(event.target.value)}
            data-testid='employee-publish-api:input:test-key'
          />
          <Button variant='outline' disabled={!testKey.trim()} onClick={() => void test()}>
            测试连接
          </Button>
        </div>
        {testResult && <p className='mt-2 text-gray-600 text-sm'>{testResult}</p>}
      </div>

      <div className='space-y-4'>
        {keys.map((key) => {
          const draft = drafts[key.id]
          if (!draft) return null
          const search = (supportSearch[key.id] ?? '').toLowerCase()
          return (
            <div className='rounded border bg-white p-4 text-sm' key={key.id}>
              <div className='flex items-center justify-between gap-3'>
                <div>
                  <span className='font-mono text-gray-500'>{key.keyPrefix}</span>
                  <span
                    className={`ml-2 rounded-full px-2 py-0.5 text-xs ${draft.active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}
                  >
                    {draft.active ? '已启用' : '已停用'}
                  </span>
                </div>
                <Button size='sm' variant='destructive' onClick={() => void remove(key)}>
                  删除
                </Button>
              </div>

              <div className='mt-3 grid gap-3 md:grid-cols-2'>
                <label className='space-y-1'>
                  <span className='text-gray-600'>名称</span>
                  <input
                    className='w-full rounded border p-2'
                    value={draft.name}
                    onChange={(event) => updateDraft(key.id, { name: event.target.value })}
                  />
                </label>
                <label className='space-y-1'>
                  <span className='text-gray-600'>身份用户</span>
                  <select
                    className='w-full rounded border p-2'
                    value={draft.userId}
                    onChange={(event) => updateDraft(key.id, { userId: event.target.value })}
                  >
                    <option value=''>请选择</option>
                    {activeUsers.map((user) => (
                      <option key={user.id} value={user.id}>
                        {label(user)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <label className='mt-3 flex items-center gap-2'>
                <input
                  type='checkbox'
                  checked={draft.active}
                  onChange={(event) => updateDraft(key.id, { active: event.target.checked })}
                />
                启用此 API Key
              </label>

              <div className='mt-4'>
                <p className='font-medium'>客服人员白名单</p>
                <p className='text-gray-500 text-xs'>
                  这些用户可在人工客服工作台回复由此 Key 创建的会话。
                </p>
                <input
                  className='mt-2 w-full rounded border p-2 text-xs'
                  placeholder='搜索姓名或邮箱'
                  value={supportSearch[key.id] ?? ''}
                  onChange={(event) =>
                    setSupportSearch((current) => ({ ...current, [key.id]: event.target.value }))
                  }
                />
                <div className='mt-2 flex flex-wrap gap-1'>
                  {draft.allowedSupportUserIds.map((userId) => {
                    const selectedUser = users.find((item) => item.id === userId)
                    return (
                      <button
                        type='button'
                        key={userId}
                        className='rounded-full bg-blue-100 px-2 py-1 text-blue-700 text-xs'
                        onClick={() =>
                          updateDraft(key.id, {
                            allowedSupportUserIds: draft.allowedSupportUserIds.filter(
                              (id) => id !== userId
                            ),
                          })
                        }
                      >
                        {selectedUser ? label(selectedUser) : userId} ×
                      </button>
                    )
                  })}
                </div>
                <div className='mt-2 max-h-36 overflow-y-auto rounded border'>
                  {activeUsers
                    .filter((user) => label(user).toLowerCase().includes(search))
                    .map((user) => {
                      const checked = draft.allowedSupportUserIds.includes(user.id)
                      return (
                        <button
                          type='button'
                          key={user.id}
                          className='flex w-full items-center gap-2 px-2 py-1 text-left text-xs hover:bg-gray-50'
                          onClick={() =>
                            updateDraft(key.id, {
                              allowedSupportUserIds: checked
                                ? draft.allowedSupportUserIds.filter((id) => id !== user.id)
                                : [...draft.allowedSupportUserIds, user.id],
                            })
                          }
                        >
                          <input type='checkbox' readOnly checked={checked} />
                          {label(user)}
                        </button>
                      )
                    })}
                </div>
              </div>

              <label className='mt-4 block space-y-1'>
                <span className='font-medium'>允许的调用域名（可选）</span>
                <textarea
                  className='min-h-20 w-full rounded border p-2 font-mono text-xs'
                  value={draft.allowedOriginsText}
                  onChange={(event) =>
                    updateDraft(key.id, { allowedOriginsText: event.target.value })
                  }
                  placeholder={'留空允许任意来源；每行一个 HTTPS Origin 或 *.example.com'}
                />
              </label>
              <p className='mt-2 text-gray-400 text-xs'>
                最后调用：{key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleString() : '尚未调用'}
              </p>
              <Button
                className='mt-3'
                size='sm'
                disabled={!draft.name.trim() || !draft.userId}
                onClick={() => void save(key.id)}
              >
                保存设置
              </Button>
            </div>
          )
        })}
        {keys.length === 0 && (
          <p className='rounded border border-dashed p-6 text-center text-gray-500 text-sm'>
            尚未发布 API Key
          </p>
        )}
      </div>

      <a
        className='inline-block text-blue-600 text-sm underline'
        href={`/employees/${employeeId}/swagger`}
        target='_blank'
        rel='noreferrer'
      >
        查看数字员工 Swagger API 文档
      </a>
    </div>
  )
}
