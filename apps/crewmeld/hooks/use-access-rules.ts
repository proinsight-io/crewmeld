import { useCallback, useEffect, useState } from 'react'
import type { ConditionTree } from '@/lib/identity/condition-tree'

/** A named, reusable access rule (client mirror of the server `AccessRule`). */
export interface AccessRule {
  id: string
  name: string
  description?: string
  tree: ConditionTree
}

/** Result of a delete attempt: 409-in-use returns the blocking references. */
export type RemoveResult =
  | { ok: true }
  | { ok: false; references: Array<{ id: string; name: string }> }

const ENDPOINT = '/api/employee/access-rules'

/**
 * Client access to the named access-rule library: loads the list on mount and
 * exposes save/remove that refresh the cached list on success. Delete maps the
 * server's 409 (rule still referenced) to a structured {@link RemoveResult}.
 */
export function useAccessRules() {
  const [rules, setRules] = useState<AccessRule[]>([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(ENDPOINT)
      const json = (await res.json()) as { success?: boolean; data?: AccessRule[] }
      if (json?.success && Array.isArray(json.data)) setRules(json.data)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const saveRule = useCallback(
    async (rule: AccessRule): Promise<{ ok: boolean }> => {
      const res = await fetch(ENDPOINT, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(rule),
      })
      if (res.ok) await refresh()
      return { ok: res.ok }
    },
    [refresh]
  )

  const removeRule = useCallback(
    async (id: string): Promise<RemoveResult> => {
      const res = await fetch(`${ENDPOINT}?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
      if (res.ok) {
        await refresh()
        return { ok: true }
      }
      if (res.status === 409) {
        const json = (await res.json()) as { references?: Array<{ id: string; name: string }> }
        return { ok: false, references: json.references ?? [] }
      }
      return { ok: false, references: [] }
    },
    [refresh]
  )

  return { rules, loading, refresh, saveRule, removeRule }
}
