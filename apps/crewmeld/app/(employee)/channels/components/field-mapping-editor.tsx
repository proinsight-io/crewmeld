'use client'

import { useEffect, useState } from 'react'
import { useTranslation } from '@/hooks/use-translation'
import type { ChannelFieldMapping, FieldPathSpec } from '@/lib/identity/field-map-types'
import { useFieldMappings } from '../hooks/use-field-mappings'

/**
 * Drop unfilled cells before persisting. A cell with an empty path or const value
 * means "no mapping for this channel" — the model represents that as an absent
 * channel key (see {@link ChannelFieldMapping}), so we omit it rather than send an
 * empty path the server rejects. Mirrors the input-clear behavior in {@link setCell}.
 */
function pruneEmptyCells(mapping: ChannelFieldMapping): ChannelFieldMapping {
  const next = structuredClone(mapping)
  for (const row of Object.values(next.paths)) {
    for (const ch of Object.keys(row)) {
      const spec = row[ch]
      const value = spec.kind === 'path' ? spec.path : spec.value
      if (!value) delete row[ch]
    }
  }
  return next
}

/**
 * Editable identifier cell for a custom field row. Holds a local draft and commits
 * the rename on blur / Enter; reverts when the value is empty, unchanged, or would
 * collide with another existing field key. Core rows render their key as plain text.
 */
function CustomKeyCell({
  fieldKey,
  existingKeys,
  onRename,
}: {
  fieldKey: string
  existingKeys: string[]
  onRename: (nextKey: string) => void
}) {
  const [val, setVal] = useState(fieldKey)
  // Re-sync when the key changes externally (rename committed / draft reset).
  useEffect(() => setVal(fieldKey), [fieldKey])
  const commit = () => {
    const next = val.trim()
    if (next && next !== fieldKey && !existingKeys.includes(next)) onRename(next)
    else setVal(fieldKey)
  }
  return (
    <input
      className='w-28 rounded border px-1 font-mono text-xs'
      value={val}
      data-testid={`field-mapping:key-input:${fieldKey}`}
      onChange={(e) => setVal(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
      }}
    />
  )
}

/** Global channel→identity field mapping matrix editor (channels page section). */
export function FieldMappingEditor() {
  const { t } = useTranslation()
  const { mapping, catalog, isLoading, isSaving, save } = useFieldMappings()
  const [draft, setDraft] = useState<ChannelFieldMapping | null>(null)
  const [status, setStatus] = useState<'idle' | 'saved' | 'error'>('idle')

  useEffect(() => {
    if (mapping) setDraft(structuredClone(mapping))
  }, [mapping])

  if (isLoading || !draft) return <div className='p-4 text-sm text-muted-foreground'>…</div>

  const channelIds = catalog.map((c) => c.id)
  const datalistId = (ch: string) => `fm-catalog-${ch}`

  const setCell = (fieldKey: string, ch: string, spec: FieldPathSpec | undefined) => {
    setDraft((d) => {
      if (!d) return d
      const next = structuredClone(d)
      const row = next.paths[fieldKey] ?? (next.paths[fieldKey] = {})
      if (spec) row[ch] = spec
      else delete row[ch]
      return next
    })
  }

  const addCustomRow = () => {
    setDraft((d) => {
      if (!d) return d
      const next = structuredClone(d)
      const key = `custom_${next.fields.filter((f) => f.isCustom).length + 1}`
      next.fields.push({ key, label: key, isCustom: true, target: 'attributes', valueType: 'string' })
      next.paths[key] = {}
      return next
    })
  }

  const renameCustomKey = (oldKey: string, newKey: string) => {
    setDraft((d) => {
      if (!d) return d
      const next = structuredClone(d)
      const f = next.fields.find((x) => x.key === oldKey)
      if (f) f.key = newKey
      if (next.paths[oldKey]) {
        next.paths[newKey] = next.paths[oldKey]
        delete next.paths[oldKey]
      }
      return next
    })
  }

  const removeCustomRow = (key: string) => {
    setDraft((d) => {
      if (!d) return d
      const next = structuredClone(d)
      next.fields = next.fields.filter((f) => f.key !== key)
      delete next.paths[key]
      return next
    })
  }

  const onSave = async () => {
    const ok = await save(pruneEmptyCells(draft))
    setStatus(ok ? 'saved' : 'error')
  }

  return (
    <div className='space-y-3' data-testid='field-mapping:editor'>
      <div className='flex items-center justify-between'>
        <div>
          <h3 className='text-base font-medium'>{t('channels.fieldMapping.title')}</h3>
          <p className='text-sm text-muted-foreground'>{t('channels.fieldMapping.subtitle')}</p>
        </div>
        <div className='flex items-center gap-2'>
          {status === 'saved' && <span className='text-sm text-green-600'>{t('channels.fieldMapping.saved')}</span>}
          {status === 'error' && <span className='text-sm text-red-600'>{t('channels.fieldMapping.saveFailed')}</span>}
          <button type='button' className='rounded bg-primary px-3 py-1 text-sm text-primary-foreground disabled:opacity-50' disabled={isSaving} onClick={onSave} data-testid='field-mapping:save'>
            {t('channels.fieldMapping.save')}
          </button>
        </div>
      </div>

      {catalog.map((c) => (
        <datalist key={c.id} id={datalistId(c.id)}>
          {c.fields.map((f) => (
            <option key={f.path} value={f.path}>{f.label}</option>
          ))}
        </datalist>
      ))}

      <div className='overflow-x-auto'>
        <table className='w-full text-sm'>
          <thead>
            <tr className='border-b text-left'>
              <th className='p-2'>{t('channels.fieldMapping.colLabel')}</th>
              <th className='p-2'>{t('channels.fieldMapping.colKey')}</th>
              {catalog.map((c) => <th key={c.id} className='p-2'>{c.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {draft.fields.map((field) => (
              <tr key={field.key} className='border-b' data-testid={`field-mapping:row:${field.key}`}>
                <td className='p-2'>
                  {field.isCustom ? (
                    <div className='flex items-center gap-1'>
                      <input
                        className='w-24 rounded border px-1'
                        value={field.label}
                        onChange={(e) => setDraft((d) => { if (!d) return d; const n = structuredClone(d); const f = n.fields.find((x) => x.key === field.key); if (f) f.label = e.target.value; return n })}
                      />
                      <button
                        type='button'
                        className='rounded border px-1 text-xs text-red-600'
                        title={t('channels.fieldMapping.removeRow')}
                        data-testid={`field-mapping:remove:${field.key}`}
                        onClick={() => removeCustomRow(field.key)}
                      >
                        ×
                      </button>
                    </div>
                  ) : (
                    field.label
                  )}
                </td>
                <td className='p-2 font-mono text-xs'>
                  {field.isCustom ? (
                    <CustomKeyCell
                      fieldKey={field.key}
                      existingKeys={draft.fields.map((x) => x.key).filter((k) => k !== field.key)}
                      onRename={(nk) => renameCustomKey(field.key, nk)}
                    />
                  ) : (
                    field.key
                  )}
                </td>
                {channelIds.map((ch) => {
                  const spec = draft.paths[field.key]?.[ch]
                  const isConst = spec?.kind === 'const'
                  return (
                    <td key={ch} className='p-2'>
                      <div className='flex items-center gap-1'>
                        <button
                          type='button'
                          className='rounded border px-1 text-xs'
                          data-testid={`field-mapping:mode-toggle:${field.key}:${ch}`}
                          onClick={() => setCell(field.key, ch, isConst ? { kind: 'path', path: '' } : { kind: 'const', value: '' })}
                        >
                          {isConst ? t('channels.fieldMapping.modeConst') : t('channels.fieldMapping.modeField')}
                        </button>
                        <input
                          className='w-32 rounded border px-1'
                          list={isConst ? undefined : datalistId(ch)}
                          placeholder={isConst ? t('channels.fieldMapping.constPlaceholder') : t('channels.fieldMapping.fieldPlaceholder')}
                          value={isConst ? (spec as { value: string }).value : (spec?.kind === 'path' ? spec.path : '')}
                          data-testid={`field-mapping:cell:${field.key}:${ch}`}
                          onChange={(e) => {
                            const v = e.target.value
                            if (!v) { setCell(field.key, ch, undefined); return }
                            setCell(field.key, ch, isConst ? { kind: 'const', value: v } : { kind: 'path', path: v })
                          }}
                        />
                      </div>
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <button type='button' className='rounded border px-3 py-1 text-sm' onClick={addCustomRow} data-testid='field-mapping:add-row'>
        {t('channels.fieldMapping.addRow')}
      </button>
    </div>
  )
}
