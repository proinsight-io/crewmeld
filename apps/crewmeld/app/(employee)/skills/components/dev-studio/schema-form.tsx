'use client'

import type * as React from 'react'
import { useRef, useState } from 'react'
import useSWR from 'swr'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { useTranslation } from '@/hooks/use-translation'

/**
 * Subset of JSON Schema Draft-07 property keywords that {@link SchemaForm}
 * understands. Anything else is silently ignored — the goal is a useful
 * 95th-percentile rendering, not a full validator.
 */
export interface JsonSchemaProperty {
  type?: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object'
  title?: string
  description?: string
  enum?: ReadonlyArray<unknown>
  format?: string
  placeholder?: string
  minimum?: number
  maximum?: number
}

/**
 * Minimal JSON Schema (Draft-07) shape the form understands. `properties` is
 * the only structural field; nested objects are surfaced as JSON textareas.
 */
export interface JsonSchema {
  properties?: Record<string, JsonSchemaProperty>
  required?: ReadonlyArray<string>
}

export interface SchemaFormProps {
  schema: JsonSchema
  values: Record<string, unknown>
  onChange: (next: Record<string, unknown>) => void
  /** Per-field validation messages (e.g. from {@link validateAgainstSchema}). */
  errors?: Record<string, string>
  /**
   * Current dev-studio session id. Required only when the schema contains
   * `format: 'file'` properties — those render a picker backed by
   * `/api/employee/dev-studio/sessions/<sessionId>/io`. Omit for adopt-time
   * forms or any context that has no live session.
   */
  sessionId?: string | null
}

/**
 * Render a JSON Schema (Draft-07 subset) as a stack of labelled controls.
 *
 * Type → control mapping:
 *  - `enum`              → shadcn Select
 *  - `boolean`           → shadcn Switch (no Checkbox primitive in the project)
 *  - `number`/`integer`  → `<Input type=number>` emitting a `number`
 *  - `array`/`object`    → `<Textarea>` with JSON serialization; invalid JSON
 *                          is passed through as a raw string so mid-edit input
 *                          is not lost (the consumer's validator will flag it
 *                          before submit)
 *  - `format=textarea`   → `<Textarea>` for plain text
 *  - default             → `<Input>` (string)
 *
 * The component is deliberately stateless: it just renders the supplied
 * `values` map and bubbles deltas up via `onChange`. The owner controls
 * persistence + validation timing.
 */
export function SchemaForm({
  schema,
  values,
  onChange,
  errors = {},
  sessionId = null,
}: SchemaFormProps) {
  const properties = schema.properties ?? {}
  const required = new Set(schema.required ?? [])

  return (
    <div className='space-y-3' data-testid='dev-studio:schema-form'>
      {Object.entries(properties).map(([key, prop]) => (
        <Field
          key={key}
          name={key}
          prop={prop}
          value={values[key]}
          required={required.has(key)}
          error={errors[key]}
          sessionId={sessionId}
          onChange={(v) => onChange({ ...values, [key]: v })}
        />
      ))}
    </div>
  )
}

interface FieldProps {
  name: string
  prop: JsonSchemaProperty
  value: unknown
  required: boolean
  error: string | undefined
  sessionId: string | null
  onChange: (v: unknown) => void
}

function Field({ name, prop, value, required, error, sessionId, onChange }: FieldProps) {
  const { t } = useTranslation()
  const id = `dev-studio-schema-form-${name}`
  const label = prop.title ?? name

  let control: React.ReactNode
  if (prop.format === 'file') {
    control = (
      <FileFieldControl
        id={id}
        name={name}
        sessionId={sessionId}
        value={typeof value === 'string' ? value : ''}
        onChange={onChange}
      />
    )
  } else if (prop.enum && prop.enum.length > 0) {
    control = (
      <Select value={String(value ?? '')} onValueChange={(v) => onChange(v)}>
        <SelectTrigger id={id} data-testid={`dev-studio:schema-form:${name}`}>
          <SelectValue placeholder={t('devStudio.schemaForm.selectPlaceholder')} />
        </SelectTrigger>
        <SelectContent>
          {prop.enum.map((opt) => {
            const str = String(opt)
            return (
              <SelectItem key={str} value={str}>
                {str}
              </SelectItem>
            )
          })}
        </SelectContent>
      </Select>
    )
  } else if (prop.type === 'boolean') {
    control = (
      <Switch
        id={id}
        checked={Boolean(value)}
        onCheckedChange={(checked) => onChange(checked)}
        data-testid={`dev-studio:schema-form:${name}`}
      />
    )
  } else if (prop.type === 'number' || prop.type === 'integer') {
    control = (
      <Input
        id={id}
        type='number'
        value={value === undefined || value === null ? '' : String(value)}
        min={prop.minimum}
        max={prop.maximum}
        onChange={(e) => {
          const raw = e.target.value
          if (raw === '') {
            onChange(undefined)
            return
          }
          const parsed = Number(raw)
          onChange(Number.isNaN(parsed) ? raw : parsed)
        }}
        data-testid={`dev-studio:schema-form:${name}`}
      />
    )
  } else if (prop.type === 'array' || prop.type === 'object') {
    const rendered = typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2)
    control = (
      <Textarea
        id={id}
        value={rendered}
        rows={4}
        onChange={(e) => onChange(safeJsonParse(e.target.value, e.target.value))}
        data-testid={`dev-studio:schema-form:${name}`}
      />
    )
  } else if (prop.format === 'textarea') {
    control = (
      <Textarea
        id={id}
        value={value === undefined || value === null ? '' : String(value)}
        rows={3}
        onChange={(e) => onChange(e.target.value)}
        data-testid={`dev-studio:schema-form:${name}`}
      />
    )
  } else {
    control = (
      <Input
        id={id}
        value={value === undefined || value === null ? '' : String(value)}
        placeholder={prop.placeholder ?? ''}
        onChange={(e) => onChange(e.target.value)}
        data-testid={`dev-studio:schema-form:${name}`}
      />
    )
  }

  return (
    <div className='space-y-1'>
      <label htmlFor={id} className='block text-sm'>
        {label}
        {required && (
          <span className='ml-0.5 text-destructive' aria-hidden='true'>
            *
          </span>
        )}
        {prop.description && (
          <span className='ml-2 text-muted-foreground text-xs'>{prop.description}</span>
        )}
      </label>
      {control}
      {error && <p className='text-destructive text-xs'>{t(error)}</p>}
    </div>
  )
}

/**
 * Best-effort JSON parse. Returns `fallback` on any error so the owner can
 * decide whether to keep the raw string (default) or revert to a prior value.
 */
function safeJsonParse<T>(raw: string, fallback: T): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

/**
 * Minimal request-side validator: only checks `required` presence + that
 * `number`/`integer` fields hold a finite number. Returns the empty map on
 * success.
 *
 * Error values are i18n keys (not user-facing text) — the owner translates
 * them at render time via {@link useTranslation}'s `t()`, keeping this a pure,
 * locale-agnostic function.
 *
 * Empty strings (`''`) count as missing for required-string fields — keeps
 * the UX consistent when the user clears an input.
 */
export function validateAgainstSchema(
  schema: JsonSchema,
  values: Record<string, unknown>
): Record<string, string> {
  const errors: Record<string, string> = {}
  const properties = schema.properties ?? {}
  const required = new Set(schema.required ?? [])

  for (const key of required) {
    const v = values[key]
    if (v === undefined || v === null || v === '') {
      errors[key] = 'devStudio.schemaForm.requiredError'
    }
  }

  for (const [key, prop] of Object.entries(properties)) {
    if (errors[key]) continue
    const v = values[key]
    if (v === undefined || v === null || v === '') continue
    if (prop.type === 'number' || prop.type === 'integer') {
      const num = typeof v === 'number' ? v : Number(v)
      if (!Number.isFinite(num)) errors[key] = 'devStudio.schemaForm.numberError'
    }
  }

  return errors
}

// ─── File field ──────────────────────────────────────────────────────────────

interface FileFieldControlProps {
  id: string
  name: string
  sessionId: string | null
  value: string
  onChange: (v: string) => void
}

interface IoFileEntry {
  name: string
  size: number
  mtime: string
}

interface IoFilesResponse {
  files: IoFileEntry[]
}

/**
 * Control for a `format: 'file'` schema property.
 *
 * Renders a stack:
 *   1. A Select of files already uploaded to
 *      `<bff-root>/io/session/<Y>/<M>/<D>/<sessionId>/`. Selecting one fills
 *      the schema field value with the bare filename — that's what the tool
 *      code receives as input (`open(f"/root/io/{filename}")`).
 *   2. An "Upload new file" button that opens a native file picker, POSTs the chosen
 *      file to `/sessions/<sid>/io/<name>`, then mutates the SWR cache to make
 *      the new entry available in the Select on the next render. The selected
 *      file is auto-set as the field value so the operator can run the test
 *      immediately after uploading.
 *
 * SWR key uses the same URL the {@link IoFilesPanel} consumes so both stay
 * in sync without explicit prop drilling.
 */
function FileFieldControl({ id, name, sessionId, value, onChange }: FileFieldControlProps) {
  const { t } = useTranslation()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)

  const swrKey = sessionId
    ? `/api/employee/dev-studio/sessions/${encodeURIComponent(sessionId)}/io`
    : null
  const { data, mutate } = useSWR<IoFilesResponse>(swrKey, async (url: string) => {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`Files list failed (${res.status})`)
    return (await res.json()) as IoFilesResponse
  })

  const files = data?.files ?? []

  const handleUploadClick = (): void => {
    fileInputRef.current?.click()
  }

  const handleFilePicked = async (event: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const picked = event.target.files?.[0]
    // Reset the native input immediately so re-uploading the same filename
    // still fires `change`. Without this, picking the same file twice in a row
    // does nothing.
    event.target.value = ''
    if (!picked || !sessionId) return

    setUploading(true)
    setUploadError(null)
    try {
      const fd = new FormData()
      fd.append('file', picked)
      const url = `/api/employee/dev-studio/sessions/${encodeURIComponent(sessionId)}/io/${encodeURIComponent(picked.name)}`
      const res = await fetch(url, { method: 'POST', body: fd })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(body.error ?? `Upload failed (${res.status})`)
      }
      await mutate()
      onChange(picked.name)
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : String(e))
    } finally {
      setUploading(false)
    }
  }

  if (!sessionId) {
    return (
      <p className='text-muted-foreground text-xs' data-testid={`dev-studio:schema-form:${name}:disabled`}>
        {t('devStudio.schemaForm.fileFieldNoSession')}
      </p>
    )
  }

  return (
    <div className='space-y-2' data-testid={`dev-studio:schema-form:${name}:file-field`}>
      <Select value={value} onValueChange={(v) => onChange(v)}>
        <SelectTrigger id={id} data-testid={`dev-studio:schema-form:${name}`}>
          <SelectValue placeholder={t('devStudio.schemaForm.filePickerPlaceholder')} />
        </SelectTrigger>
        <SelectContent>
          {files.length === 0 ? (
            <div className='px-2 py-1.5 text-muted-foreground text-xs'>
              {t('devStudio.schemaForm.filePickerEmpty')}
            </div>
          ) : (
            files.map((f) => (
              <SelectItem key={f.name} value={f.name}>
                {f.name}
              </SelectItem>
            ))
          )}
        </SelectContent>
      </Select>
      <div className='flex items-center gap-2'>
        <Button
          type='button'
          variant='outline'
          size='sm'
          onClick={handleUploadClick}
          disabled={uploading}
          data-testid={`dev-studio:schema-form:${name}:upload`}
        >
          {uploading
            ? t('devStudio.schemaForm.fileUploading')
            : t('devStudio.schemaForm.fileUploadButton')}
        </Button>
        <input
          ref={fileInputRef}
          type='file'
          className='hidden'
          onChange={handleFilePicked}
          data-testid={`dev-studio:schema-form:${name}:native-input`}
        />
      </div>
      {uploadError && <p className='text-destructive text-xs'>{uploadError}</p>}
    </div>
  )
}
