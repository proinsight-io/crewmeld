'use client'

import { Boxes, FileCode2, Package, Server } from 'lucide-react'
import useSWR from 'swr'
import { cn } from '@/lib/core/utils/cn'
import type { ManifestT } from '@/lib/dev-studio/manifest-reader'
import { useTranslation } from '@/hooks/use-translation'
import { useEgressMode } from './dev-studio/hooks/use-egress-mode'
import { EgressEditor } from './egress-editor'

interface ManifestResponse {
  data: { manifest: ManifestT }
}

/**
 * Fetch the read-only dev-studio manifest for a tool template. Resolves to
 * `null` on 404 (non-dev-studio tool / never adopted) so the caller renders
 * nothing; throws on other transport errors so SWR surfaces them.
 */
async function manifestFetcher(url: string): Promise<ManifestT | null> {
  const res = await fetch(url)
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`Manifest request failed (${res.status})`)
  const body = (await res.json()) as ManifestResponse
  return body.data.manifest
}

/** Small labelled pill used for libraries / domains / files. */
function Chip({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <span className='inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 font-mono text-[11px] text-gray-600'>
      {icon}
      {label}
    </span>
  )
}

/**
 * Read-only manifest metadata card for a dev-studio tool, surfaced inside the
 * instance editor. Renders the AI-generated contract that operators cannot
 * edit here (editing requires re-opening Dev Studio): kind/image/version,
 * declared libraries/domains, packaged files, and input/output schemas.
 *
 * Self-contained: fetches `/api/employee/skills/:toolId/manifest` itself and
 * renders nothing when the tool has no manifest, so callers can mount it
 * unconditionally for dev-studio tools.
 */
export function ManifestInfoPanel({ toolId }: { toolId: string }) {
  const { t } = useTranslation()
  const manifestUrl = `/api/employee/skills/${encodeURIComponent(toolId)}/manifest`
  const { data: manifest, error } = useSWR<ManifestT | null>(manifestUrl, manifestFetcher)
  // Egress whitelist is only enforced in allowlist mode — hide the editor when
  // egress is unrestricted (it would be inert), matching the test panel.
  const egressMode = useEgressMode()

  // Loading: data still undefined and no error yet.
  if (manifest === undefined && !error) {
    return (
      <p className='text-gray-400 text-xs' data-testid='skills:manifest-panel:loading'>
        {t('skills.manifestLoading')}
      </p>
    )
  }
  if (error) {
    return (
      <p className='text-amber-600 text-xs' data-testid='skills:manifest-panel:error'>
        {t('skills.manifestLoadFailed')}
      </p>
    )
  }
  // 404 → no manifest for this tool; render nothing.
  if (!manifest) return null

  const { libraries, domains, ips } = manifest.dependencies

  return (
    <div className='space-y-3' data-testid='skills:manifest-panel'>
      <div className='flex items-center gap-1.5'>
        <Boxes className='h-4 w-4 text-gray-500' />
        <p className='font-medium text-gray-700 text-sm'>{t('skills.manifestTitle')}</p>
        <span className='rounded-full bg-gray-100 px-2 py-0.5 text-[10px] text-gray-500'>
          {t('skills.manifestReadonly')}
        </span>
      </div>

      {/* kind / version / image badges */}
      <div className='flex flex-wrap items-center gap-1.5'>
        <span
          className={cn(
            'inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium text-[11px]',
            manifest.kind === 'service'
              ? 'bg-blue-50 text-blue-600'
              : 'bg-violet-50 text-violet-600'
          )}
        >
          {manifest.kind === 'service' ? (
            <Server className='h-3 w-3' />
          ) : (
            <FileCode2 className='h-3 w-3' />
          )}
          {manifest.kind}
        </span>
        <span className='rounded-full bg-gray-100 px-2 py-0.5 font-mono text-[11px] text-gray-500'>
          v{manifest.version}
        </span>
        {manifest.image && (
          <span className='inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 font-mono text-[11px] text-gray-600'>
            <Package className='h-3 w-3' />
            {manifest.image}
          </span>
        )}
      </div>

      {/* entrypoint */}
      <Field label={t('skills.manifestEntrypoint')}>
        <code className='font-mono text-gray-700 text-xs'>{manifest.entrypoint}</code>
      </Field>

      {/* libraries */}
      <Field label={t('skills.manifestLibraries')}>
        {libraries.length > 0 ? (
          <div className='flex flex-wrap gap-1.5'>
            {libraries.map((lib) => (
              <Chip key={lib} icon={<Package className='h-3 w-3 text-violet-500' />} label={lib} />
            ))}
          </div>
        ) : (
          <span className='text-gray-400 text-xs'>{t('skills.manifestNone')}</span>
        )}
      </Field>

      {/* egress allow-list — always editable so operators can pre-stage it from
          the same network endpoints they enter as env vars; only ENFORCED in
          allowlist mode. A banner marks it inactive under unrestricted. */}
      {egressMode === 'unrestricted' && (
        <p
          className='rounded-md bg-amber-50 px-2 py-1.5 text-amber-700 text-xs'
          data-testid='skills:egress-unrestricted-note'
        >
          {t('skills.egressUnrestrictedNote')}
        </p>
      )}
      <EgressEditor
        toolId={toolId}
        initialDomains={domains}
        initialIps={ips}
        manifestKey={manifestUrl}
      />

      {/* packaged files */}
      <Field label={t('skills.manifestFiles')}>
        {manifest.files.length > 0 ? (
          <div className='flex flex-wrap gap-1.5'>
            {manifest.files.map((fpath) => (
              <Chip
                key={fpath}
                icon={<FileCode2 className='h-3 w-3 text-gray-400' />}
                label={fpath}
              />
            ))}
          </div>
        ) : (
          <span className='text-gray-400 text-xs'>{t('skills.manifestNone')}</span>
        )}
      </Field>

      {/* input parameters */}
      <Field label={t('skills.manifestInput')}>
        <SchemaTable schema={manifest.input} testId='skills:manifest-panel:input-table' />
      </Field>

      {/* output */}
      <Field label={t('skills.manifestOutput')}>
        <OutputInfo output={manifest.output} />
      </Field>
    </div>
  )
}

/** Label + value row. */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className='space-y-1'>
      <p className='font-medium text-gray-500 text-xs'>{label}</p>
      {children}
    </div>
  )
}

/** A single input parameter declaration extracted from the JSON-Schema `input`. */
interface InputProp {
  type?: string
  description?: string
  default?: unknown
  enum?: unknown[]
}

/**
 * Defensively pull `properties` + `required` out of the manifest's JSON-Schema
 * `input` (a freeform `Record<string, unknown>`), mirroring the same shape the
 * README generator reads in `manifest-to-tool.ts`.
 */
function parseInputSchema(input: Record<string, unknown>): {
  props: Record<string, InputProp>
  required: string[]
} {
  const props =
    typeof input === 'object' &&
    input !== null &&
    'properties' in input &&
    input.properties &&
    typeof input.properties === 'object'
      ? (input.properties as Record<string, InputProp>)
      : {}
  const required =
    typeof input === 'object' &&
    input !== null &&
    'required' in input &&
    Array.isArray(input.required)
      ? (input.required as string[])
      : []
  return { props, required }
}

/**
 * JSON-Schema (`{ properties, required }`) rendered as a Parameter / Type /
 * Required / Description table. Shared by the manifest's `input` and by a
 * `json` `output.schema`, which carry the same shape.
 */
function SchemaTable({ schema, testId }: { schema: Record<string, unknown>; testId: string }) {
  const { t } = useTranslation()
  const { props, required } = parseInputSchema(schema)
  const keys = Object.keys(props)

  if (keys.length === 0) {
    return <span className='text-gray-400 text-xs'>{t('skills.manifestNone')}</span>
  }

  return (
    <div className='overflow-x-auto rounded-lg border border-gray-200'>
      <table className='min-w-full text-xs' data-testid={testId}>
        <thead className='bg-gray-100 text-left text-gray-600'>
          <tr>
            <th className='px-3 py-1.5 font-medium'>{t('skills.manifestParamName')}</th>
            <th className='px-3 py-1.5 font-medium'>{t('skills.manifestParamType')}</th>
            <th className='px-3 py-1.5 font-medium'>{t('skills.manifestParamRequired')}</th>
            <th className='px-3 py-1.5 font-medium'>{t('skills.manifestParamDesc')}</th>
          </tr>
        </thead>
        <tbody>
          {keys.map((key) => {
            const prop = props[key]
            const hasEnum = Array.isArray(prop?.enum) && prop.enum.length > 0
            return (
              <tr key={key} className='border-gray-100 border-t align-top'>
                <td className='px-3 py-1.5 font-mono text-gray-700'>{key}</td>
                <td className='px-3 py-1.5 font-mono text-gray-500'>{prop?.type ?? 'string'}</td>
                <td className='px-3 py-1.5'>
                  {required.includes(key) ? (
                    <span className='text-red-500'>{t('skills.manifestParamRequiredYes')}</span>
                  ) : (
                    <span className='text-gray-400'>{t('skills.manifestParamRequiredNo')}</span>
                  )}
                </td>
                <td className='px-3 py-1.5 text-gray-600'>
                  {prop?.description ?? ''}
                  {prop?.default !== undefined && (
                    <span className='ml-1 text-gray-400'>
                      ({t('skills.manifestDefault')}:{' '}
                      <code className='font-mono'>{String(prop.default)}</code>)
                    </span>
                  )}
                  {hasEnum && (
                    <span className='ml-1 text-gray-400'>
                      (enum: <code className='font-mono'>{prop.enum?.map(String).join(' | ')}</code>
                      )
                    </span>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/** Output declaration rendered as a friendly kind badge plus its detail. */
function OutputInfo({ output }: { output: ManifestT['output'] }) {
  return (
    <div className='space-y-1'>
      <div className='flex items-center gap-2'>
        <span className='rounded-full bg-gray-100 px-2 py-0.5 font-mono text-[11px] text-gray-600'>
          {output.type}
        </span>
        {output.type === 'files' && (
          <code className='font-mono text-gray-500 text-xs'>{output.dir}</code>
        )}
      </div>
      {output.type === 'json' &&
        output.schema &&
        (Object.keys(parseInputSchema(output.schema).props).length > 0 ? (
          <SchemaTable schema={output.schema} testId='skills:manifest-panel:output-table' />
        ) : (
          // Non-standard schema (no `properties`) → fall back to raw JSON.
          <details className='group'>
            <summary className='cursor-pointer text-gray-500 text-xs hover:text-gray-700'>
              schema
            </summary>
            <pre className='mt-1 max-h-48 overflow-auto rounded-lg bg-gray-900 p-3 font-mono text-[11px] text-gray-100 leading-5'>
              {JSON.stringify(output.schema, null, 2)}
            </pre>
          </details>
        ))}
    </div>
  )
}
