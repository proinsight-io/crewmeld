'use client'

import { useCallback, useState } from 'react'
import type { DirectoryUser } from '@/lib/channels/org-directory-types'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'

interface UserPickerProps {
  connectionId: string
  value: string[]
  onChange: (ids: string[]) => void
}

/**
 * Department-scoped user picker. The user enters a department id; members load
 * paged via /api/employee/channels/[id]/users?deptId=&q=&cursor=.
 */
export function UserPicker({ connectionId, value, onChange }: UserPickerProps) {
  const [deptId, setDeptId] = useState('')
  const [q, setQ] = useState('')
  const [users, setUsers] = useState<DirectoryUser[]>([])
  const [cursor, setCursor] = useState<string | undefined>(undefined)
  const [loading, setLoading] = useState(false)

  const fetchPage = useCallback(
    async (reset: boolean) => {
      if (!deptId) return
      setLoading(true)
      try {
        const sp = new URLSearchParams({ deptId, q })
        if (!reset && cursor) sp.set('cursor', cursor)
        const res = await fetch(`/api/employee/channels/${connectionId}/users?${sp.toString()}`)
        const json = (await res.json()) as { data?: { users?: DirectoryUser[]; nextCursor?: string } }
        setUsers((prev) => (reset ? (json.data?.users ?? []) : [...prev, ...(json.data?.users ?? [])]))
        setCursor(json.data?.nextCursor)
      } finally {
        setLoading(false)
      }
    },
    [connectionId, deptId, q, cursor]
  )

  const toggle = useCallback(
    (id: string) => onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]),
    [value, onChange]
  )

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <Input
          placeholder="部门 ID"
          value={deptId}
          onChange={(e) => setDeptId(e.target.value)}
          data-testid="sop-permission:user-deptid"
        />
        <Input placeholder="搜索姓名/工号" value={q} onChange={(e) => setQ(e.target.value)} />
        <Button type="button" onClick={() => void fetchPage(true)} disabled={loading}>
          查询
        </Button>
      </div>
      <ul className="max-h-48 overflow-auto rounded border p-2">
        {users.map((u) => (
          <li key={u.userId} className="flex items-center gap-2">
            <Checkbox
              checked={value.includes(u.userId)}
              onCheckedChange={() => toggle(u.userId)}
              data-testid={`sop-permission:user-option:${u.userId}`}
            />
            <span className="text-sm">
              {u.name} <span className="text-muted-foreground">({u.userId})</span>
            </span>
          </li>
        ))}
      </ul>
      {cursor && (
        <Button type="button" variant="ghost" onClick={() => void fetchPage(false)} disabled={loading}>
          加载更多
        </Button>
      )}
    </div>
  )
}
