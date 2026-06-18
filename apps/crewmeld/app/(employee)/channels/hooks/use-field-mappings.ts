'use client'

import { useCallback, useEffect, useState } from 'react'
import type { RawFieldDef } from '@/lib/channels/plugin-types'
import type { ChannelFieldMapping } from '@/lib/identity/field-map-types'

interface CatalogChannel {
  id: string
  label: string
  fields: RawFieldDef[]
}

/**
 * Loads the global field map + per-channel raw-field catalog; exposes save.
 *
 * @returns Hook state: mapping, catalog, isLoading, isSaving, save, reload
 */
export function useFieldMappings() {
  const [mapping, setMapping] = useState<ChannelFieldMapping | null>(null)
  const [catalog, setCatalog] = useState<CatalogChannel[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)

  const load = useCallback(async () => {
    setIsLoading(true)
    try {
      const [mapRes, catRes] = await Promise.all([
        fetch('/api/employee/channel-field-mappings'),
        fetch('/api/employee/channels/field-catalog'),
      ])
      const mapJson = await mapRes.json()
      const catJson = await catRes.json()
      if (mapJson.success) setMapping(mapJson.data as ChannelFieldMapping)
      if (catJson.success) setCatalog(catJson.data.channels as CatalogChannel[])
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const save = useCallback(async (next: ChannelFieldMapping): Promise<boolean> => {
    setIsSaving(true)
    try {
      const res = await fetch('/api/employee/channel-field-mappings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      })
      const json = await res.json()
      if (json.success) setMapping(next)
      return Boolean(json.success)
    } finally {
      setIsSaving(false)
    }
  }, [])

  return { mapping, catalog, isLoading, isSaving, save, reload: load }
}
