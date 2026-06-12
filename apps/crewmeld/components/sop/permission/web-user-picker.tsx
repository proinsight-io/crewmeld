'use client'

import { useCallback, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'

interface WebUserPickerProps {
  value: string[]
  onChange: (ids: string[]) => void
}

interface WebUser {
  userId: string
  name: string
}

/**
 * Platform-user picker for the SOP "Web" permission tab. Web callers have no
 * departments, so this is a flat search box + checklist over platform users.
 * Stores `userId`, which equals the web conversation caller id matched against
 * the visibility `employeeId` field.
 */
export function WebUserPicker({ value, onChange }: WebUserPickerProps) {
  const [q, setQ] = useState('')
  const [users, setUsers] = useState<WebUser[]>([])
  const [loading, setLoading] = useState(false)

  const search = useCallback(async () => {
    setLoading(true)
    try {
      const sp = new URLSearchParams()
      if (q.trim()) sp.set('q', q.trim())
      const res = await fetch(`/api/employee/web-directory/users?${sp.toString()}`)
      const json = (await res.json()) as { data?: { users?: WebUser[] } }
      setUsers(json.data?.users ?? [])
    } finally {
      setLoading(false)
    }
  }, [q])

  const toggle = useCallback(
    (id: string) => onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]),
    [value, onChange]
  )

  return (
    <div className='space-y-2'>
      <div className='flex gap-2'>
        <Input
          placeholder='搜索姓名/邮箱'
          value={q}
          onChange={(e) => setQ(e.target.value)}
          data-testid='sop-permission:web-user-search'
        />
        <Button type='button' onClick={() => void search()} disabled={loading}>
          查询
        </Button>
      </div>
      <ul className='max-h-48 overflow-auto rounded border p-2'>
        {users.map((u) => (
          <li key={u.userId} className='flex items-center gap-2'>
            <Checkbox
              checked={value.includes(u.userId)}
              onCheckedChange={() => toggle(u.userId)}
              data-testid={`sop-permission:web-user-option:${u.userId}`}
            />
            <span className='text-sm'>
              {u.name} <span className='text-muted-foreground'>({u.userId})</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
