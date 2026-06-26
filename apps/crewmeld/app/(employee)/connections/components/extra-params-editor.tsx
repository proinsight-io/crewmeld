'use client'

import { useCallback } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useTranslation } from '@/hooks/use-translation'

/** Editable row for a single user-defined request parameter. */
export interface ExtraParamRow {
  key: string
  value: string
}

/**
 * Infer a JSON value from a raw string input so common LLM params land with the
 * right type: `"true"/"false"` → boolean, numeric strings → number, a `{...}` /
 * `[...]` literal → parsed object/array (e.g. Doubao `thinking={"type":"disabled"}`),
 * else the raw string. Empty strings stay strings (never coerced to 0); an
 * unparseable object/array literal also falls back to the raw string.
 */
export function inferParamValue(raw: string): unknown {
  const trimmed = raw.trim()
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  if (trimmed !== '' && !Number.isNaN(Number(trimmed))) return Number(trimmed)
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed)
    } catch {
      return raw
    }
  }
  return raw
}

/**
 * Expand a stored `extraParams` object into editable rows. Non-object input
 * (undefined / null / legacy shapes) yields an empty list.
 */
export function extraParamsToRows(extraParams: unknown): ExtraParamRow[] {
  return extraParams && typeof extraParams === 'object'
    ? Object.entries(extraParams as Record<string, unknown>).map(([key, value]) => ({
        key,
        // Object/array values round-trip as JSON text so inferParamValue can
        // parse them back; primitives stringify directly. Keeps the editor
        // symmetric with what was stored.
        value:
          value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value),
      }))
    : []
}

/**
 * Collapse editable rows into an object, inferring value types and dropping
 * rows with a blank key. Always returned (possibly empty) so callers can send
 * it on every save and let the API's spread merge overwrite cleared params.
 */
export function rowsToExtraParams(rows: ExtraParamRow[]): Record<string, unknown> {
  return rows.reduce<Record<string, unknown>>((acc, { key, value }) => {
    const trimmedKey = key.trim()
    if (trimmedKey) acc[trimmedKey] = inferParamValue(value)
    return acc
  }, {})
}

interface ExtraParamsEditorProps {
  rows: ExtraParamRow[]
  onChange: (rows: ExtraParamRow[]) => void
}

/**
 * Controlled key/value editor for user-defined LLM request parameters. The
 * parent owns the row state; this component only renders and mutates it.
 */
export function ExtraParamsEditor({ rows, onChange }: ExtraParamsEditorProps) {
  const { t } = useTranslation()

  const addRow = useCallback(() => onChange([...rows, { key: '', value: '' }]), [rows, onChange])

  const updateRow = useCallback(
    (index: number, field: keyof ExtraParamRow, val: string) =>
      onChange(rows.map((row, i) => (i === index ? { ...row, [field]: val } : row))),
    [rows, onChange]
  )

  const removeRow = useCallback(
    (index: number) => onChange(rows.filter((_, i) => i !== index)),
    [rows, onChange]
  )

  return (
    <div className='space-y-2'>
      <div className='flex items-center justify-between'>
        <Label>{t('connections.modelConfigExtraParams')}</Label>
        <Button type='button' variant='ghost' size='sm' onClick={addRow}>
          <Plus className='mr-1 h-4 w-4' />
          {t('connections.modelConfigAddParam')}
        </Button>
      </div>
      <p className='text-gray-400 text-xs'>{t('connections.modelConfigExtraParamsHint')}</p>
      {rows.map((row, index) => (
        <div key={index} className='flex items-center gap-2'>
          <Input
            value={row.key}
            onChange={(e) => updateRow(index, 'key', e.target.value)}
            placeholder={t('connections.modelConfigParamKeyPlaceholder')}
            className='flex-1'
          />
          <Input
            value={row.value}
            onChange={(e) => updateRow(index, 'value', e.target.value)}
            placeholder={t('connections.modelConfigParamValuePlaceholder')}
            className='flex-1'
          />
          <Button
            type='button'
            variant='ghost'
            size='icon'
            onClick={() => removeRow(index)}
            aria-label={t('common.delete')}
          >
            <Trash2 className='h-4 w-4 text-gray-400' />
          </Button>
        </div>
      ))}
    </div>
  )
}
