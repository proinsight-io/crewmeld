'use client'

import { useCallback, useMemo, useRef, useState } from 'react'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import type { OnConnectionChange } from '@/lib/dev-studio/connection-context'
import type { ManifestT } from '@/lib/dev-studio/manifest-reader'
import type { DoneEvent, PhaseEvent, ResultEvent } from '@/lib/dev-studio/sandbox-loader'
import { useTranslation } from '@/hooks/use-translation'
import { AdoptConfirmDialog } from './adopt-confirm-dialog'
import { ConnectionPicker } from './connection-picker'
import { DependencyListEditor } from './dependency-list-editor'
import { useEgressMode } from './hooks/use-egress-mode'
import { useNotifications } from './hooks/use-notifications'
import { IoFilesPanel } from './io-files-panel'
import { RunControls } from './run-controls'
import { SandboxLogViewer } from './sandbox-log-viewer'
import { type JsonSchema, SchemaForm, validateAgainstSchema } from './schema-form'
import { TestProgress } from './test-progress'
import { type RunTestResult, TestResult } from './test-result'
import { ToolMetaSummary } from './tool-meta-summary'

interface TestPanelProps {
  sessionId: string
  manifest: ManifestT | null
  /**
   * Manifest-load error from {@link useManifest}. When the workspace has a
   * manifest that fails to parse/validate (HTTP 422 `manifest-invalid`), the
   * panel surfaces the reason instead of the generic "not generated yet"
   * empty state — otherwise an invalid manifest reads as a silent blank panel.
   */
  manifestError?: Error | null
  /**
   * Optional callback invoked after a successful adopt action. The
   * dev-studio dialog uses this to tear down its own chrome once the
   * container is destroyed; passing it through is harmless when omitted.
   */
  onAdoptSuccess?: () => void
  /**
   * Session-bound system connection id. Lifted to the dialog so this picker
   * and the header selector stay in sync. The run-test POST sends it so the
   * sandbox injects the connection's `CONN_*` values. Optional so the panel can
   * be rendered standalone (tests / no-connection sessions) — defaults to null.
   */
  connectionId?: string | null
  /** Fired when the operator picks/clears a connection here. */
  onConnectionChange?: OnConnectionChange
}

/**
 * Test tab assembly: summary banner -> connection picker -> env form ->
 * param form -> extra egress -> run/clear/copy/adopt controls ->
 * progress -> result panel + log viewer modal + adopt-confirm modal.
 *
 * State lives at this level because every child needs slices of it:
 *  - `inputValues` drives both the param form and the copy-cmd builder;
 *  - `envValues` carries the env form state (prefilled from connection);
 *  - `events` feeds TestProgress;
 *  - `result` is shared between RunControls (so it can be cleared) and
 *    the TestResult panel itself;
 *  - `adoptOpen` is set by RunControls and consumed by AdoptConfirmDialog.
 *
 * The run button initiates a POST with SSE streaming; frames are parsed
 * incrementally via ReadableStream.
 */
export function TestPanel({
  sessionId,
  manifest,
  manifestError,
  onAdoptSuccess,
  connectionId = null,
  onConnectionChange,
}: TestPanelProps) {
  const { t } = useTranslation()

  // Adoption is gated until the operator approves the package allow-list in the
  // inline chat card. While this session has unapproved deps, the adopt button
  // stays hidden — the review card (left pane) is the path forward.
  const { dependencies } = useNotifications()
  const canAdopt = !dependencies.some((d) => d.sessionId === sessionId)

  // The per-run ephemeral allowlist input only matters in allowlist mode; hide it when
  // egress is unrestricted (default). Unknown (loading) → treated as hidden.
  const egressMode = useEgressMode()

  // ── Input params ──
  const [inputValues, setInputValues] = useState<Record<string, unknown>>({})

  // ── Env form ──
  const [envValues, setEnvValues] = useState<Record<string, unknown>>({})

  // ── Connection ──
  // `connectionId` is owned by the dialog (shared with the header selector) and
  // arrives via props; this panel only reports changes back up.

  // ── Extra egress ──
  const [extraEgress, setExtraEgress] = useState('')

  // ── Run state ──
  const [running, setRunning] = useState(false)
  const [events, setEvents] = useState<PhaseEvent[]>([])
  const [result, setResult] = useState<RunTestResult | null>(null)
  const [doneEvent, setDoneEvent] = useState<DoneEvent | null>(null)
  const [adoptOpen, setAdoptOpen] = useState(false)
  const [runError, setRunError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  // ── Log viewer ──
  const [logViewerOpen, setLogViewerOpen] = useState(false)

  const inputSchema = (manifest?.input ?? {}) as JsonSchema
  const envSchema = manifest?.env as JsonSchema | undefined
  const validationErrors = useMemo(
    () => validateAgainstSchema(inputSchema, inputValues),
    [inputSchema, inputValues]
  )
  const formValid = Object.keys(validationErrors).length === 0
  /**
   * Show the io files panel when the tool involves files in either direction:
   *   - any input property has `format: file` (operator pre-uploads), or
   *   - the manifest declares a file-producing output type
   *     (`files` / `image` / `pdf`), in which case the operator likely wants
   *     to inspect both inputs and outputs in one place.
   */
  const hasFileSchema = useMemo(() => {
    if (schemaHasFileField(inputSchema)) return true
    const outType = manifest?.output?.type
    return outType === 'files' || outType === 'image' || outType === 'pdf'
  }, [inputSchema, manifest])

  /**
   * Handle connection selection: prefill the env form from the connection's
   * config preview, then report the change up to the dialog (which owns the
   * shared `connectionId` and the model-facing context).
   */
  const handleConnectionChange = useCallback<OnConnectionChange>(
    (id, info) => {
      if (id && info && envSchema) {
        const prefilled = clientPrefillEnv(envSchema.properties ?? {}, info.configPreview)
        setEnvValues((prev) => ({ ...prev, ...prefilled }))
      }
      onConnectionChange?.(id, info)
    },
    [envSchema, onConnectionChange]
  )

  if (!manifest) {
    // A manifest exists but failed to parse/validate → tell the operator why
    // (with the server's detail) instead of the generic "not generated" state.
    if (manifestError) {
      return (
        <div
          className='m-4 space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm'
          data-testid='dev-studio:test-panel:manifest-error'
        >
          <p className='font-medium text-destructive'>{t('devStudio.test.manifestInvalidTitle')}</p>
          <p className='text-muted-foreground text-xs'>{t('devStudio.test.manifestInvalidHint')}</p>
          <pre className='overflow-x-auto whitespace-pre-wrap rounded bg-muted p-2 text-muted-foreground text-xs'>
            {manifestError.message}
          </pre>
        </div>
      )
    }
    return (
      <div
        className='flex h-full items-center justify-center p-8 text-center text-muted-foreground text-sm'
        data-testid='dev-studio:test-panel:empty'
      >
        {t('devStudio.test.empty')}
      </div>
    )
  }

  async function onRun() {
    setRunning(true)
    setRunError(null)
    setEvents([])
    setResult(null)
    setDoneEvent(null)

    const abort = new AbortController()
    abortRef.current = abort

    const egressLines = extraEgress
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)

    try {
      const res = await fetch(
        `/api/employee/dev-studio/sessions/${encodeURIComponent(sessionId)}/run-test`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            input: inputValues,
            env: envValues,
            extraEgress: egressLines,
            connectionId,
          }),
          signal: abort.signal,
        }
      )

      if (res.status === 409) {
        setRunError(t('devStudio.test.errorConcurrent'))
        return
      }
      if (!res.ok || !res.body) {
        setRunError(t('devStudio.test.runFailed', { status: res.status }))
        return
      }

      // ── SSE consumption via ReadableStream ──
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''

      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const frames = buf.split('\n\n')
        buf = frames.pop() ?? ''

        for (const frame of frames) {
          const lines = frame.split('\n')
          const dataLine = lines.find((l) => l.startsWith('data: '))
          if (!dataLine) continue
          try {
            const parsed = JSON.parse(dataLine.slice(6)) as Record<string, unknown>
            const eventType = parsed.type as string

            if (eventType === 'phase') {
              setEvents((prev) => [...prev, parsed as unknown as PhaseEvent])
            } else if (eventType === 'result') {
              const resultEvt = parsed as unknown as ResultEvent
              setResult({
                result: {
                  stdout:
                    typeof resultEvt.data === 'string'
                      ? resultEvt.data
                      : JSON.stringify(resultEvt.data ?? '', null, 2),
                  stderr: resultEvt.schemaError ?? '',
                  exitCode: resultEvt.success ? 0 : 1,
                  durationMs: 0,
                },
              })
            } else if (eventType === 'done') {
              setDoneEvent(parsed as unknown as DoneEvent)
            }
          } catch {
            // Malformed SSE frame — skip silently.
          }
        }
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        setRunError(e instanceof Error ? e.message : String(e))
      }
    } finally {
      setRunning(false)
      abortRef.current = null
    }
  }

  /** Whether the env form section should be rendered. */
  const hasEnvSchema = envSchema?.properties && Object.keys(envSchema.properties).length > 0

  return (
    <div className='space-y-4 p-4' data-testid='dev-studio:test-panel'>
      <ToolMetaSummary manifest={manifest} />

      {/* Actual dependency list — pre-filled, optional to edit/save. */}
      <DependencyListEditor sessionId={sessionId} />

      {/* Connection picker — only when manifest declares a connectorType */}
      {manifest.connectorType && (
        <ConnectionPicker
          connectorType={manifest.connectorType}
          value={connectionId}
          onChange={handleConnectionChange}
        />
      )}

      {/* Env form — only when manifest declares env properties */}
      {hasEnvSchema && (
        <div>
          <h4 className='mb-2 font-medium text-sm'>{t('devStudio.test.envFormTitle')}</h4>
          <EnvForm schema={envSchema!} values={envValues} onChange={setEnvValues} />
        </div>
      )}

      {/* Per-session test files — only when the manifest declares format:file fields */}
      {hasFileSchema && <IoFilesPanel sessionId={sessionId} />}

      {/* Input params form (existing) */}
      <div>
        <h4 className='mb-2 font-medium text-sm'>{t('devStudio.test.paramsHeading')}</h4>
        <SchemaForm
          schema={inputSchema}
          values={inputValues}
          onChange={setInputValues}
          errors={validationErrors}
          sessionId={sessionId}
        />
      </div>

      {/* Extra egress textarea — only meaningful in allowlist mode. In
          unrestricted mode the sandbox reaches anything, so the per-run
          ephemeral allowlist is inert and hidden. */}
      {egressMode === 'allowlist' && (
        <div>
          <label className='mb-1 block text-sm' htmlFor='test-panel-extra-egress'>
            {t('devStudio.test.extraEgressLabel')}
          </label>
          <Textarea
            id='test-panel-extra-egress'
            value={extraEgress}
            onChange={(e) => setExtraEgress(e.target.value)}
            rows={3}
            className='font-mono text-sm'
            placeholder={t('devStudio.test.extraEgressPlaceholder')}
            data-testid='test-panel:textarea:extra-egress'
          />
        </div>
      )}

      <RunControls
        sessionId={sessionId}
        manifest={manifest}
        values={inputValues}
        formValid={formValid}
        running={running}
        onRun={onRun}
        onClear={() => {
          setResult(null)
          setRunError(null)
          setEvents([])
          setDoneEvent(null)
        }}
        onAdopt={() => setAdoptOpen(true)}
        canAdopt={canAdopt}
      />

      {runError && (
        <div
          className='rounded border border-destructive p-2 text-destructive text-sm'
          data-testid='dev-studio:test-panel:run-error'
        >
          {runError}
        </div>
      )}

      {/* Progress timeline — visible once streaming starts */}
      {events.length > 0 && <TestProgress events={events} />}

      {result && (
        <TestResult
          result={result}
          manifest={manifest}
          sessionId={sessionId}
          executionId={doneEvent?.executionId}
          kept={doneEvent?.kept}
          onViewLog={doneEvent?.kept ? () => setLogViewerOpen(true) : undefined}
        />
      )}

      <AdoptConfirmDialog
        open={adoptOpen}
        sessionId={sessionId}
        onClose={() => setAdoptOpen(false)}
        onSuccess={onAdoptSuccess}
      />

      {/* Log viewer modal for retained sandbox */}
      {doneEvent?.sandboxId && (
        <SandboxLogViewer
          sessionId={sessionId}
          sandboxId={doneEvent.sandboxId}
          open={logViewerOpen}
          onClose={() => setLogViewerOpen(false)}
        />
      )}
    </div>
  )
}

/**
 * `true` when the supplied JSON Schema has at least one direct property with
 * `format: 'file'`. Used by {@link TestPanel} to decide whether to show the
 * per-session io files panel — tools without file IO get a leaner UI.
 */
function schemaHasFileField(schema: JsonSchema): boolean {
  const props = schema.properties ?? {}
  for (const prop of Object.values(props)) {
    if (prop.format === 'file') return true
  }
  return false
}

// ── Prefill heuristic ──
// Lightweight client-side copy of the strip-prefix + fuzzy-eq logic from
// connection-resolver.ts (which is server-only due to db/crypto imports).

const STRIP_PREFIXES = [
  'MYSQL_',
  'POSTGRES_',
  'PG_',
  'DB_',
  'OPENAI_',
  'GITHUB_',
  'GITLAB_',
  'DISCORD_',
  'TELEGRAM_',
  'WECOM_',
  'DINGTALK_',
  'FEISHU_',
  'WXOA_',
] as const

function stripPrefix(envKey: string): string {
  for (const p of STRIP_PREFIXES) {
    if (envKey.startsWith(p)) return envKey.slice(p.length)
  }
  return envKey
}

function fuzzyEq(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[_-]/g, '')
  return norm(a) === norm(b)
}

/**
 * Match env schema property names against connection config keys using
 * prefix-strip + fuzzy-equal. Returns only matched entries.
 */
function clientPrefillEnv(
  envProperties: Record<string, unknown>,
  configPreview: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  const configKeys = Object.keys(configPreview)
  for (const envKey of Object.keys(envProperties)) {
    const stripped = stripPrefix(envKey)
    const match = configKeys.find((k) => fuzzyEq(stripped, k))
    if (match !== undefined) {
      result[envKey] = configPreview[match]
    }
  }
  return result
}

// ── Env Form ──

interface EnvFormProps {
  schema: JsonSchema
  values: Record<string, unknown>
  onChange: (next: Record<string, unknown>) => void
}

/**
 * Dedicated env form that handles `format: 'password'` fields with a
 * masked input. Non-password fields render as plain text inputs.
 */
function EnvForm({ schema, values, onChange }: EnvFormProps) {
  const properties = schema.properties ?? {}

  return (
    <div className='space-y-3' data-testid='dev-studio:env-form'>
      {Object.entries(properties).map(([key, prop]) => {
        const isPassword = (prop as Record<string, unknown>).format === 'password'
        const val = values[key]
        const id = `test-panel-env-${key}`

        return (
          <div key={key} className='space-y-1'>
            <label htmlFor={id} className='block text-sm'>
              {((prop as Record<string, unknown>).title as string) ?? key}
              {(prop as Record<string, unknown>).description && (
                <span className='ml-2 text-muted-foreground text-xs'>
                  {(prop as Record<string, unknown>).description as string}
                </span>
              )}
            </label>
            <Input
              id={id}
              type={isPassword ? 'password' : 'text'}
              value={val === undefined || val === null ? '' : String(val)}
              onChange={(e) => onChange({ ...values, [key]: e.target.value })}
              data-testid={`test-panel:input:env-${key}`}
            />
          </div>
        )
      })}
    </div>
  )
}
