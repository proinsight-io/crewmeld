'use client'

import { useEffect, useMemo, useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { ConnectionType } from '@/lib/connectors/types'
import {
  CONNECTION_TYPE_I18N_KEYS,
  CONNECTION_TYPE_ICONS,
  SYSTEM_CONNECTION_TYPE_LIST,
} from '@/lib/connectors/types'
import { cn } from '@/lib/core/utils/cn'
import type { OnConnectionChange } from '@/lib/dev-studio/connection-context'
import { useTranslation } from '@/hooks/use-translation'

/** One system connection as returned by GET /connectors?withConfig=true. */
interface ConnectionEntry {
  id: string
  name: string
  type: string
  configPreview?: Record<string, unknown>
}

interface ConnectionSelectorProps {
  /** Currently-selected connection id, or null for "no connection". */
  value: string | null
  /** Fired with the chosen connection id + its metadata (null when cleared). */
  onChange: OnConnectionChange
  /** Disables the selector — true while the model is generating a response. */
  disabled?: boolean
}

/**
 * Header connection picker for dev-studio.
 *
 * A two-level menu: the top level lists connection *types* (collapsed); the
 * connections themselves live in a per-type submenu that opens on demand —
 * mirroring the system connections page and keeping a long mixed list tidy.
 * On selection the metadata is forwarded so the dialog can persist the choice,
 * surface the connection's `CONN_*` variable names to the model, and drive the
 * mid-session prompt.
 *
 * Distinct from the test-panel `ConnectionPicker`, which is gated by the
 * manifest's `connectorType` and filtered by type; this one is unfiltered and
 * always available once a session exists.
 */
export function ConnectionSelector({ value, onChange, disabled }: ConnectionSelectorProps) {
  const { t } = useTranslation()
  const [connections, setConnections] = useState<ConnectionEntry[]>([])

  useEffect(() => {
    let cancelled = false
    fetch('/api/employee/connectors?withConfig=true')
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        const list = json?.data?.connections as ConnectionEntry[] | undefined
        if (!cancelled && Array.isArray(list)) setConnections(list)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  // Group by type, ordering known system types first (canonical list order) and
  // any unrecognised types after, so the menu layout stays stable.
  const groups = useMemo(() => {
    const byType = new Map<string, ConnectionEntry[]>()
    for (const c of connections) {
      // Only surface officially-supported connection types. Stray/legacy rows
      // with an unrecognised type (e.g. old `ai-agent` test data) aren't
      // managed on the connections page and would otherwise show a raw,
      // unlocalized group label here.
      if (!(c.type in CONNECTION_TYPE_I18N_KEYS)) continue
      const arr = byType.get(c.type) ?? []
      arr.push(c)
      byType.set(c.type, arr)
    }
    const primary = SYSTEM_CONNECTION_TYPE_LIST.filter((tp) => byType.has(tp))
    const extra = [...byType.keys()].filter(
      (tp) => !SYSTEM_CONNECTION_TYPE_LIST.includes(tp as ConnectionType)
    )
    return [...primary, ...extra].map((type) => ({ type, items: byType.get(type) ?? [] }))
  }, [connections])

  const selected = value ? (connections.find((c) => c.id === value) ?? null) : null

  /** Icon + localized name for a connection type (falls back to the raw type). */
  function typeLabel(type: string): string {
    const key = CONNECTION_TYPE_I18N_KEYS[type as ConnectionType]
    return key ? t(key) : type
  }
  function typeIcon(type: string): string {
    return CONNECTION_TYPE_ICONS[type as ConnectionType] ?? '🔧'
  }

  function pick(entry: ConnectionEntry) {
    onChange(entry.id, {
      name: entry.name,
      type: entry.type,
      configPreview: entry.configPreview ?? {},
    })
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        data-testid='dev-studio:connection-selector'
        className={cn(
          'flex h-8 w-[180px] items-center justify-between gap-1 rounded-md border border-input bg-background px-3 text-xs',
          'ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
          'disabled:cursor-not-allowed disabled:opacity-50'
        )}
      >
        <span className={cn('truncate', !selected && 'text-muted-foreground')}>
          {selected ? selected.name : t('devStudio.connectionSelector.label')}
        </span>
        <ChevronDown className='size-4 shrink-0 opacity-50' />
      </DropdownMenuTrigger>
      <DropdownMenuContent align='start' className='max-h-[60vh] w-[200px] overflow-y-auto'>
        <DropdownMenuItem
          data-testid='dev-studio:connection-selector:item:none'
          onSelect={() => onChange(null, null)}
        >
          <Check className={cn('mr-2 size-4', value ? 'opacity-0' : 'opacity-100')} />
          {t('devStudio.connectionSelector.none')}
        </DropdownMenuItem>

        {groups.length > 0 && <DropdownMenuSeparator />}

        {groups.map(({ type, items }) => (
          <DropdownMenuSub key={type}>
            <DropdownMenuSubTrigger data-testid={`dev-studio:connection-selector:group:${type}`}>
              <span className='mr-2'>{typeIcon(type)}</span>
              <span className='truncate'>{typeLabel(type)}</span>
              <span className='ml-1 text-muted-foreground text-xs'>({items.length})</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className='max-h-[60vh] overflow-y-auto'>
              {items.map((c) => (
                <DropdownMenuItem
                  key={c.id}
                  data-testid={`dev-studio:connection-selector:item:${c.id}`}
                  onSelect={() => pick(c)}
                >
                  <Check
                    className={cn('mr-2 size-4', value === c.id ? 'opacity-100' : 'opacity-0')}
                  />
                  <span className='truncate'>{c.name}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
