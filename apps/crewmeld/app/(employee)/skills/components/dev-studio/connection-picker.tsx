'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Plus } from 'lucide-react'
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
import type { OnConnectionChange } from '@/lib/dev-studio/connection-context'
import { AddConnectionWizard } from '@/app/(employee)/connections/components/add-connection-wizard'
import { useTranslation } from '@/hooks/use-translation'

interface ConnectorType {
  type: string
  subtype?: string
}

interface ConnectionEntry {
  id: string
  name: string
  /** Actual connection type as stored on the row (not the manifest's declared type). */
  type?: string
  configPreview?: Record<string, unknown>
}

interface ConnectionPickerProps {
  connectorType?: ConnectorType
  value: string | null
  onChange: OnConnectionChange
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

/** A connection's subtype, read from the (masked) config preview's dbType field. */
function entrySubtype(entry: ConnectionEntry): string | undefined {
  const v = entry.configPreview?.dbType
  return typeof v === 'string' ? v : undefined
}

/**
 * Dropdown that suggests connections matching the manifest's `connectorType`
 * but never hides one the operator actually wants.
 *
 * It fetches the **full, unfiltered** connection list (the same source the
 * header selector and the instance editor use) and applies the manifest's
 * `connectorType` filter **client-side**. This deliberately mirrors the
 * instance editor rather than the old server-side `?type=&subtype=` filter,
 * which was stricter and left the dropdown empty whenever the AI-generated
 * manifest's connectorType did not line up with a real connection's type.
 *
 *  - the **type-matched** subset is the primary suggestion;
 *  - when nothing matches, it **falls back to the full list** so a connection
 *    can still be picked;
 *  - the **already-bound** connection (`value`, e.g. chosen in the header) is
 *    always merged in even when off-type, so the test panel reflects the same
 *    selection as the header instead of rendering a blank trigger (whose lone
 *    "—" option would silently clear the binding).
 *
 * On selection the resolved `configPreview` + the connection's real `type` are
 * forwarded so the env form can be pre-filled and the model context is accurate.
 *
 * Renders nothing when `connectorType` is undefined — the tool manifest has no
 * connector declaration.
 */
export function ConnectionPicker({ connectorType, value, onChange }: ConnectionPickerProps) {
  const { t } = useTranslation()
  const [all, setAll] = useState<ConnectionEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [wizardOpen, setWizardOpen] = useState(false)

  const load = useCallback(async (): Promise<ConnectionEntry[]> => {
    setLoading(true)
    try {
      const res = await fetch('/api/employee/connectors?withConfig=true')
      if (!res.ok) return []
      // The connectors endpoint wraps its payload in the standard apiOk
      // envelope: { success, data: { connections, total } }. Read it
      // defensively — a missing/changed shape must never set the list to
      // undefined (that crashed the render on `.length`).
      const body = (await res.json()) as { data?: { connections?: ConnectionEntry[] } }
      const list = Array.isArray(body.data?.connections) ? body.data.connections : []
      setAll(list)
      return list
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!connectorType) return
    void load()
  }, [connectorType, load])

  // Displayed options: type matches when present, else the full list; with the
  // bound (possibly off-type) connection pinned to the top so it is selectable.
  const displayed = useMemo<ConnectionEntry[]>(() => {
    if (!connectorType) return []
    const typed = all.filter(
      (c) =>
        c.type === connectorType.type &&
        (!connectorType.subtype || entrySubtype(c) === connectorType.subtype)
    )
    const base = typed.length > 0 ? typed : all
    if (value && !base.some((c) => c.id === value)) {
      const bound = all.find((c) => c.id === value)
      if (bound) return [bound, ...base]
    }
    return base
  }, [all, connectorType, value])

  if (!connectorType) return null

  function handleSelect(id: string) {
    if (id === NONE_VALUE) {
      onChange(null, null)
      return
    }
    const entry = displayed.find((c) => c.id === id)
    onChange(
      id,
      entry
        ? {
            name: entry.name,
            // Prefer the connection's real type; fall back to the manifest's
            // declared type only when the row did not carry one.
            type: entry.type ?? connectorType?.type ?? '',
            configPreview: entry.configPreview ?? {},
          }
        : null
    )
  }

  /**
   * Re-fetch after a create and auto-select the entry that was not present
   * before — a best-effort "pick the connection you just made" without relying
   * on the wizard to return the new id.
   */
  async function handleCreated() {
    if (!connectorType) return
    const before = new Set(all.map((c) => c.id))
    const after = await load()
    const created = after.find((c) => !before.has(c.id))
    if (created) {
      onChange(created.id, {
        name: created.name,
        type: created.type ?? connectorType.type,
        configPreview: created.configPreview ?? {},
      })
    }
  }

  const preselectedType = toConnectionType(connectorType.type)
  const isEmpty = displayed.length === 0 && !loading

  return (
    <div data-testid='test-panel:connection-picker'>
      {/* Presentational heading (not a <label>): the control is a Radix
          Select with no associatable native input, so a <label htmlFor> has
          nothing to bind to. */}
      <span className='mb-1 block text-sm'>{t('devStudio.test.connectionPickerLabel')}</span>
      <div className='flex items-center gap-2'>
        <Select value={value ?? NONE_VALUE} onValueChange={handleSelect} disabled={loading}>
          <SelectTrigger data-testid='test-panel:connection-picker:trigger' className='flex-1'>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE_VALUE}>—</SelectItem>
            {displayed.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type='button'
          variant='outline'
          size='sm'
          data-testid='test-panel:connection-picker:create'
          onClick={() => setWizardOpen(true)}
        >
          <Plus className='mr-1 h-3 w-3' />
          {t('devStudio.test.connectionCreate')}
        </Button>
      </div>
      {isEmpty && (
        <p
          data-testid='test-panel:connection-picker:empty'
          className='mt-1 text-muted-foreground text-xs'
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
