'use client'

import { useCallback, useEffect, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import type { DepartmentNode } from '@/lib/channels/org-directory-types'
import { Checkbox } from '@/components/ui/checkbox'

interface DeptPickerProps {
  connectionId: string
  /** Selected department ids. */
  value: string[]
  onChange: (ids: string[]) => void
}

/**
 * Lazy-loading department tree. Fetches children of a node on first expand via
 * /api/employee/channels/[id]/departments?parentId=.
 */
export function DeptPicker({ connectionId, value, onChange }: DeptPickerProps) {
  const [roots, setRoots] = useState<DepartmentNode[]>([])
  const [childrenMap, setChildrenMap] = useState<Record<string, DepartmentNode[]>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const load = useCallback(
    async (parentId?: string): Promise<DepartmentNode[]> => {
      const q = parentId ? `?parentId=${encodeURIComponent(parentId)}` : ''
      const res = await fetch(`/api/employee/channels/${connectionId}/departments${q}`)
      const json = (await res.json()) as { data?: { items?: DepartmentNode[] } }
      return json.data?.items ?? []
    },
    [connectionId]
  )

  useEffect(() => {
    void load().then(setRoots)
  }, [load])

  const toggleExpand = useCallback(
    async (node: DepartmentNode) => {
      const next = new Set(expanded)
      if (next.has(node.id)) {
        next.delete(node.id)
      } else {
        next.add(node.id)
        if (!childrenMap[node.id]) {
          const kids = await load(node.id)
          setChildrenMap((m) => ({ ...m, [node.id]: kids }))
        }
      }
      setExpanded(next)
    },
    [expanded, childrenMap, load]
  )

  const toggleSelect = useCallback(
    (id: string) => {
      onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id])
    },
    [value, onChange]
  )

  const renderNodes = (nodes: DepartmentNode[], depth: number) => (
    <ul>
      {nodes.map((n) => (
        <li key={n.id}>
          <div className="flex items-center gap-1" style={{ paddingLeft: depth * 16 }}>
            <button
              type="button"
              onClick={() => void toggleExpand(n)}
              className={n.hasChildren === false ? 'invisible' : ''}
              data-testid={`sop-permission:dept-expand:${n.id}`}
            >
              <ChevronRight className={`h-4 w-4 ${expanded.has(n.id) ? 'rotate-90' : ''}`} />
            </button>
            <Checkbox
              checked={value.includes(n.id)}
              onCheckedChange={() => toggleSelect(n.id)}
              data-testid={`sop-permission:dept-option:${n.id}`}
            />
            <span className="text-sm">{n.name}</span>
          </div>
          {expanded.has(n.id) && childrenMap[n.id] && renderNodes(childrenMap[n.id], depth + 1)}
        </li>
      ))}
    </ul>
  )

  return <div className="max-h-64 overflow-auto rounded border p-2">{renderNodes(roots, 0)}</div>
}
