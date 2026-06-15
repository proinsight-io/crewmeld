'use client'

import { useCallback, useEffect, useState } from 'react'
import { Checkbox } from '@/components/ui/checkbox'

interface WebRolePickerProps {
  value: string[]
  onChange: (ids: string[]) => void
}

interface WebRole {
  id: string
  name: string
}

/**
 * RBAC-role picker for the SOP "Web" permission tab. Stores the role `id`, which
 * is the platform role NAME (e.g. `'admin'`) — the same id-space that
 * resolveWebIdentity puts into `ScopeIdentity.roles`, so the matcher compares
 * like for like.
 */
export function WebRolePicker({ value, onChange }: WebRolePickerProps) {
  const [roles, setRoles] = useState<WebRole[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch('/api/employee/web-directory/roles')
        const json = (await res.json()) as { data?: { roles?: WebRole[] } }
        if (!cancelled) setRoles(json.data?.roles ?? [])
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const toggle = useCallback(
    (id: string) => onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]),
    [value, onChange]
  )

  return (
    <ul className='max-h-48 overflow-auto rounded border p-2'>
      {loading ? (
        <li className='text-sm text-muted-foreground'>加载中...</li>
      ) : (
        roles.map((r) => (
          <li key={r.id} className='flex items-center gap-2'>
            <Checkbox
              checked={value.includes(r.id)}
              onCheckedChange={() => toggle(r.id)}
              data-testid={`sop-permission:web-role-option:${r.id}`}
            />
            <span className='text-sm'>{r.name}</span>
          </li>
        ))
      )}
    </ul>
  )
}
