'use client'

import { useCallback, useEffect, useState } from 'react'
import { Plus } from 'lucide-react'
import { AddConnectionWizard } from '@/app/(employee)/connections/components/add-connection-wizard'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { ConnectionType } from '@/lib/connectors/types'
import { SYSTEM_CONNECTION_TYPE_LIST } from '@/lib/connectors/types'
import { useTranslation } from '@/hooks/use-translation'

interface ConnectorType {
  type: string
  subtype?: string
}

interface ConnectionEntry {
  id: string
  name: string
  configPreview?: Record<string, unknown>
}

interface ConnectionPickerProps {
  connectorType?: ConnectorType
  value: string | null
  onChange: (id: string | null, config: Record<string, unknown>) => void
}

/** Sentinel value for the "no connection selected" dropdown item. */
const NONE_VALUE = '__none__'

/**
 * Narrow a manifest `connectorType.type` string to a known system
 * {@link ConnectionType}, or undefined when it is not a system-connection type
 * (in which case the wizard opens on its own type-selection step).
 */
function toConnectionType(type: string): ConnectionType | undefined {
  return SYSTEM_CONNECTION_TYPE_LIST.find((known) => known === type)
}

/**
 * Dropdown that fetches connections filtered by `connectorType.type` (and
 * optionally `connectorType.subtype`) and lets the user pick one. On selection
 * the resolved `configPreview` is forwarded to the caller so the env form can
 * be pre-filled.
 *
 * When no connection of the needed type exists yet, an inline "New connection" entry
 * opens {@link AddConnectionWizard} in place — the dev-studio container / test
 * page is never navigated away from, so it is not torn down. After a successful
 * create the list is re-fetched and the new connection auto-selected.
 *
 * Renders nothing when `connectorType` is undefined — the tool manifest has no
 * connector declaration.
 */
export function ConnectionPicker({ connectorType, value, onChange }: ConnectionPickerProps) {
  const { t } = useTranslation()
  const [connections, setConnections] = useState<ConnectionEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [wizardOpen, setWizardOpen] = useState(false)

  const fetchConnections = useCallback(
    async (ct: ConnectorType): Promise<ConnectionEntry[]> => {
      setLoading(true)
      try {
        const params = new URLSearchParams({
          type: ct.type,
          withConfig: 'true',
        })
        if (ct.subtype) params.set('subtype', ct.subtype)

        const res = await fetch(`/api/employee/connectors?${params.toString()}`)
        if (!res.ok) return []
        // The connectors endpoint wraps its payload in the standard apiOk
        // envelope: { success, data: { connections, total } }. Read it
        // defensively — a missing/changed shape must never set `connections`
        // to undefined (that crashed the render on `connections.length`).
        const body = (await res.json()) as { data?: { connections?: ConnectionEntry[] } }
        const list = Array.isArray(body.data?.connections) ? body.data.connections : []
        setConnections(list)
        return list
      } finally {
        setLoading(false)
      }
    },
    []
  )

  useEffect(() => {
    if (!connectorType) return
    fetchConnections(connectorType)
  }, [connectorType, fetchConnections])

  if (!connectorType) return null

  function handleSelect(id: string) {
    if (id === NONE_VALUE) {
      onChange(null, {})
      return
    }
    const entry = connections.find((c) => c.id === id)
    onChange(id, entry?.configPreview ?? {})
  }

  /**
   * Re-fetch after a create and auto-select the entry that was not present
   * before — a best-effort "pick the connection you just made" without relying
   * on the wizard to return the new id.
   */
  async function handleCreated() {
    if (!connectorType) return
    const before = new Set(connections.map((c) => c.id))
    const after = await fetchConnections(connectorType)
    const created = after.find((c) => !before.has(c.id))
    if (created) onChange(created.id, created.configPreview ?? {})
  }

  const preselectedType = toConnectionType(connectorType.type)
  const isEmpty = connections.length === 0 && !loading

  return (
    <div data-testid="test-panel:connection-picker">
      <label className="mb-1 block text-sm">
        {t('devStudio.test.connectionPickerLabel')}
      </label>
      <div className="flex items-center gap-2">
        <Select value={value ?? NONE_VALUE} onValueChange={handleSelect} disabled={loading}>
          <SelectTrigger
            data-testid="test-panel:connection-picker:trigger"
            className="flex-1"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE_VALUE}>—</SelectItem>
            {connections.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid="test-panel:connection-picker:create"
          onClick={() => setWizardOpen(true)}
        >
          <Plus className="mr-1 h-3 w-3" />
          {t('devStudio.test.connectionCreate')}
        </Button>
      </div>
      {isEmpty && (
        <p
          data-testid="test-panel:connection-picker:empty"
          className="mt-1 text-muted-foreground text-xs"
        >
          {t('devStudio.test.connectionEmptyHint')}
        </p>
      )}
      <AddConnectionWizard
        open={wizardOpen}
        onOpenChange={setWizardOpen}
        onCreated={handleCreated}
        preselectedType={preselectedType}
      />
    </div>
  )
}
