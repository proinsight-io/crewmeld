'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import JSZip from 'jszip'
import {
  AlertTriangle,
  ArrowUpCircle,
  CheckCheck,
  CheckCircle2,
  ChevronLeft,
  Copy,
  Download,
  ExternalLink,
  Globe,
  Info,
  KeyRound,
  Layers,
  Loader2,
  Package,
  Pencil,
  Plus,
  Power,
  Rocket,
  Settings2,
  Sparkles,
  Trash2,
  Upload,
  Wrench,
  X,
} from 'lucide-react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { copyToClipboard } from '@/lib/core/utils/clipboard'
import { cn } from '@/lib/core/utils/cn'
import { useTranslation } from '@/hooks/use-translation'
import { PermissionGuard } from '../components/permission-guard'
// import { loadOfficialTools } from './load-official-skills'
import { AiToolGenerator } from './components/ai-tool-generator'
import { ApiKeyPanel } from './components/api-key-panel'
import { ApiToolEditor } from './components/api-tool-editor'
import { DevStudioDialog } from './components/dev-studio/dev-studio-dialog'
import { useSessionList } from './components/dev-studio/hooks/use-session-list'
import { RedeployPrompt } from './components/redeploy-prompt'
import { ToolEditor } from './components/skill-editor'
import type { ApiToolPackage } from '@/lib/tools/api-tool-package'
import type { DeployInfo, GitHubProjectContext, SkillPackage, ToolInstance } from './types'
import { skillEnvName } from './types'

type Tab = 'installed' // | 'official'

// Tab labels are resolved via t() in the component
const TABS_META = [
  { key: 'installed' as Tab, tKey: 'skills.tabInstalled' as const, icon: Package },
  // { key: 'official' as Tab, tKey: 'skills.tabOfficial' as const, icon: BadgeCheck },
]

// Compare versions: v1 > v2 returns 1, equal 0, v1 < v2 returns -1
function compareVersions(v1: string, v2: string): number {
  const normalize = (v: string) => v.replace(/^[vV]/, '')
  const parts1 = normalize(v1).split('.').map(Number)
  const parts2 = normalize(v2).split('.').map(Number)
  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const a = parts1[i] ?? 0
    const b = parts2[i] ?? 0
    if (a > b) return 1
    if (a < b) return -1
  }
  return 0
}

/** Generate current date version: V1.0.20260318 */
function getCurrentVersion(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `V1.0.${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
}

/** Display version: keep V/v prefix as-is, otherwise add v */
function fmtVer(v: string): string {
  return /^[vV]/.test(v) ? v : `v${v}`
}

/** Auto-generate API doc from parameters (fallback when AI does not generate apiDoc) */
function generateApiDoc(
  params:
    | {
        type: string
        properties: Record<string, { type: string; description: string; secret?: boolean }>
        required?: string[]
      }
    | undefined,
  testParams?: Record<string, string>,
  t?: (key: string, vars?: Record<string, string | number>) => string
): string {
  if (!params?.properties) return ''
  const entries = Object.entries(params.properties).filter(([, p]) => !p.secret)
  if (entries.length === 0) return ''
  const yes = t?.('skills.paramYes') ?? 'Yes'
  const no = t?.('skills.paramNo') ?? 'No'
  const rows = entries.map(([key, prop]) => {
    const required = params.required?.includes(key) ? yes : no
    const example = testParams?.[key] ?? ''
    return `| ${key} | ${prop.type} | ${required} | ${prop.description} | ${example} |`
  })
  const header =
    t?.('skills.paramTableHeader') ?? 'Parameter | Type | Required | Description | Example'
  return [
    `## ${t?.('skills.paramTitle') ?? 'API Parameters'}`,
    '',
    `| ${header} |`,
    '|--------|------|------|------|--------|',
    ...rows,
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Template card (installed tab)
// ---------------------------------------------------------------------------
function TemplateCard({
  skill,
  instanceCount,
  deployedCount,
  latestVersion,
  installed,
  onInstall,
  onUninstall,
  onUpgrade,
  onClick,
  onEditMeta,
  onEdit,
  onExport,
  onDevelop,
  onPublish,
  onToggleForwardIdentity,
}: {
  skill: SkillPackage
  instanceCount: number
  deployedCount: number
  latestVersion?: string
  installed?: boolean
  onInstall?: () => void
  onUninstall?: () => void
  onUpgrade?: () => void
  onClick?: () => void
  onEditMeta?: () => void
  /** Open a full editor for this tool (used for api-kind tools) */
  onEdit?: () => void
  onExport?: () => void
  /** Open DevStudio filtered to this tool (dev-studio source only) */
  onDevelop?: () => void
  /** Open publish-as-API settings dialog (api-kind tools only) */
  onPublish?: () => void
  /** Toggle this tool's template-level forward-identity flag directly from the card. */
  onToggleForwardIdentity?: (next: boolean) => void
}) {
  const { t } = useTranslation()
  const needsUpgrade =
    latestVersion !== undefined && compareVersions(latestVersion, skill.version) > 0

  return (
    <div
      className={cn(
        'flex flex-col rounded-xl border border-gray-200 bg-white p-5 shadow-sm transition hover:shadow-md',
        onClick && 'cursor-pointer'
      )}
      onClick={() => onClick?.()}
      data-testid={`skills:template-card:${skill.id}`}
    >
      <div className='mb-3 flex items-start justify-between gap-2'>
        <div className='flex items-center gap-3'>
          <div className='flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-blue-50'>
            <Package className='h-5 w-5 text-blue-600' />
          </div>
          <div>
            <div className='flex items-center gap-1.5'>
              <p
                className={cn(
                  'font-semibold text-gray-900 text-sm',
                  onClick && 'hover:text-violet-600'
                )}
              >
                {skill.name}
              </p>
              {skill.source === 'dev-studio' && (
                <Badge variant='outline' className='border-green-200 bg-green-50 text-green-700'>
                  {t('devStudio.source.devStudio')}
                </Badge>
              )}
              {skill.source === 'installed' && (
                <Badge variant='outline' className='border-gray-200 bg-gray-50 text-gray-600'>
                  {t('devStudio.source.installed')}
                </Badge>
              )}
              {skill.source === 'official' && (
                <Badge variant='outline' className='border-blue-200 bg-blue-50 text-blue-700'>
                  {t('devStudio.source.official')}
                </Badge>
              )}
              {skill.kind === 'api' && (
                <Badge variant='outline' className='border-cyan-200 bg-cyan-50 text-cyan-700'>
                  API
                </Badge>
              )}
              {onEditMeta && (
                <button
                  type='button'
                  onClick={(e) => {
                    e.stopPropagation()
                    onEditMeta()
                  }}
                  className='shrink-0 rounded p-0.5 text-gray-400 hover:bg-violet-50 hover:text-violet-600'
                  title={t('skills.editMeta')}
                  data-testid={`skills:button:edit-meta:${skill.id}`}
                >
                  <Pencil className='h-3.5 w-3.5' />
                </button>
              )}
            </div>
            <div className='flex items-center gap-1.5'>
              <p className='text-gray-400 text-xs'>
                {fmtVer(skill.version)} · {skill.size}
              </p>
              {needsUpgrade && (
                <span className='rounded-full bg-amber-100 px-1.5 py-0.5 font-medium text-amber-700 text-xs'>
                  {t('skills.upgradeAvailable', { version: fmtVer(latestVersion!) })}
                </span>
              )}
            </div>
          </div>
        </div>
        <div className='flex flex-col items-end gap-1'>
          {/* Instance stats */}
          {instanceCount > 0 && (
            <span className='flex shrink-0 items-center gap-1 rounded-full bg-blue-50 px-2 py-0.5 font-medium text-blue-600 text-xs'>
              <Layers className='h-3 w-3' />
              {t('skills.instanceCount', { count: instanceCount })}
            </span>
          )}
          {deployedCount > 0 && (
            <span className='shrink-0 rounded-full bg-green-50 px-2 py-0.5 font-medium text-green-600 text-xs'>
              {t('skills.deployedCount', { deployed: deployedCount })}
            </span>
          )}
        </div>
      </div>

      <p className='mb-3 text-gray-500 text-sm leading-relaxed'>{skill.description}</p>

      <div className='mt-auto flex items-center justify-between text-gray-400 text-xs'>
        <div className='flex items-center gap-2'>
          <span>
            {skill.author
              ? t('skills.author', { name: skill.author })
              : t('skills.installedAt', { date: skill.uploadedAt })}
          </span>
          {onToggleForwardIdentity ? (
            <span
              className='flex items-center gap-1'
              onClick={(e) => e.stopPropagation()}
            >
              <Switch
                id={`fwd-identity-${skill.id}`}
                checked={skill.forwardIdentity ?? false}
                onCheckedChange={onToggleForwardIdentity}
                className='scale-75'
                data-testid={`skills:switch:forward-identity:${skill.id}`}
              />
              <label
                htmlFor={`fwd-identity-${skill.id}`}
                className='cursor-pointer select-none whitespace-nowrap text-gray-500'
              >
                传身份
              </label>
            </span>
          ) : null}
          {skill.url && (
            <a
              href={skill.url}
              target='_blank'
              rel='noopener noreferrer'
              className='flex items-center gap-0.5 text-blue-500 hover:text-blue-700'
              onClick={(e) => e.stopPropagation()}
            >
              <ExternalLink className='h-3 w-3' />
              {t('skills.details')}
            </a>
          )}
        </div>
        <div className='flex items-center gap-0.5' onClick={(e) => e.stopPropagation()}>
          {installed && !needsUpgrade && !onUninstall && (
            <span className='flex items-center gap-0.5 rounded-md px-1.5 py-1 text-green-600'>
              <CheckCheck className='h-3.5 w-3.5' />
              {t('skills.installed')}
            </span>
          )}
          {needsUpgrade && onUpgrade && (
            <button
              type='button'
              onClick={onUpgrade}
              className='flex items-center gap-0.5 rounded-md px-1.5 py-1 text-amber-600 hover:bg-amber-50'
            >
              <ArrowUpCircle className='h-3.5 w-3.5' />
              {t('skills.upgrade')}
            </button>
          )}
          {onInstall && (
            <button
              type='button'
              onClick={onInstall}
              className='flex items-center gap-0.5 rounded-md px-1.5 py-1 text-blue-600 hover:bg-blue-50'
            >
              <Download className='h-3.5 w-3.5' />
              {t('skills.install')}
            </button>
          )}
          {onDevelop && (
            <button
              type='button'
              onClick={onDevelop}
              className='flex items-center gap-0.5 rounded-md px-1.5 py-1 text-emerald-600 hover:bg-emerald-50'
              data-testid={`skills:button:develop:${skill.id}`}
            >
              <Wrench className='h-3.5 w-3.5' />
              {t('skills.develop')}
            </button>
          )}
          {onEdit && (
            <button
              type='button'
              onClick={onEdit}
              className='flex items-center gap-0.5 rounded-md px-1.5 py-1 text-violet-600 hover:bg-violet-50'
              data-testid={`skills:button:edit-api-tool:${skill.id}`}
            >
              <Settings2 className='h-3.5 w-3.5' />
              {t('skills.editTool')}
            </button>
          )}
          {onPublish && (
            <button
              type='button'
              onClick={onPublish}
              className='flex items-center gap-0.5 rounded-md px-1.5 py-1 text-cyan-600 hover:bg-cyan-50'
              data-testid={`skills:button:publish-api-tool:${skill.id}`}
            >
              <Globe className='h-3.5 w-3.5' />
              发布
            </button>
          )}
          {onExport && (
            <button
              type='button'
              onClick={onExport}
              className='flex items-center gap-0.5 rounded-md px-1.5 py-1 text-gray-500 hover:bg-gray-50'
              data-testid={`skills:button:export:${skill.id}`}
            >
              <Upload className='h-3.5 w-3.5' />
              {t('skills.exportTool')}
            </button>
          )}
          {onUninstall && (
            <button
              type='button'
              onClick={onUninstall}
              className='flex items-center gap-0.5 rounded-md px-1.5 py-1 text-red-500 hover:bg-red-50'
            >
              <Trash2 className='h-3.5 w-3.5' />
              {t('skills.uninstall')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Instance card
// ---------------------------------------------------------------------------
/** JSON-Schema types whose preset/example values must serialize as unquoted numbers. */
const NUMERIC_SCHEMA_TYPES = new Set(['number', 'integer', 'float', 'double'])

/**
 * Build an example input object for the deploy-endpoint curl, coercing each
 * field to its manifest-declared JSON type. presetParams are stored as strings,
 * so numeric/boolean fields must be parsed back — the deployed service receives
 * this JSON verbatim through the sandbox proxy and validates types strictly
 * (e.g. an `integer` field rejects the string "13", a `number` field "3.14").
 * `presets` is consulted in order; the first non-empty value wins.
 */
function buildCurlInput(
  properties: Record<string, { type?: string; description?: string }>,
  presets: Array<Record<string, string> | undefined>
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, prop] of Object.entries(properties)) {
    let raw: string | undefined
    for (const preset of presets) {
      const val = preset?.[key]
      if (val !== undefined && val !== null && val !== '') {
        raw = val
        break
      }
    }
    const isNumeric = prop.type !== undefined && NUMERIC_SCHEMA_TYPES.has(prop.type)
    if (raw !== undefined) {
      if (isNumeric) {
        const n = Number(raw)
        out[key] = Number.isFinite(n) ? n : raw
      } else if (prop.type === 'boolean') {
        out[key] = raw === 'true'
      } else {
        out[key] = raw
      }
    } else {
      out[key] = isNumeric ? 0 : prop.type === 'boolean' ? true : prop.description || key
    }
  }
  return out
}

function InstanceCard({
  instance,
  template,
  onDeploy,
  onUndeploy,
  onOpen,
  onEdit,
  onRename,
  onDelete,
  onExportCompose,
  deploying,
  undeploying,
  onTogglePublishApi,
}: {
  instance: ToolInstance
  template: SkillPackage
  onDeploy?: () => void
  onUndeploy?: () => void
  onOpen?: () => void
  onEdit?: () => void
  onRename?: (newName: string) => void
  onDelete?: () => void
  onExportCompose?: () => void
  deploying?: boolean
  undeploying?: boolean
  onTogglePublishApi?: (checked: boolean) => void
}) {
  const { t } = useTranslation()
  const deployStatus = instance.deploy?.status
  const [editing, setEditing] = useState(false)
  const [editName, setEditName] = useState(instance.name)
  const nameInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) {
      nameInputRef.current?.focus()
      nameInputRef.current?.select()
    }
  }, [editing])

  const handleRenameConfirm = () => {
    const trimmed = editName.trim()
    if (trimmed && trimmed !== instance.name && onRename) {
      onRename(trimmed)
    }
    setEditing(false)
  }

  return (
    <div
      className='flex flex-col rounded-xl border border-gray-200 bg-white p-5 shadow-sm transition hover:shadow-md'
      data-testid={`skills:instance-card:${instance.id}`}
    >
      <div className='mb-3 flex items-start justify-between gap-2'>
        <div className='flex items-center gap-3'>
          <div className='flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-violet-50'>
            <Layers className='h-5 w-5 text-violet-600' />
          </div>
          <div>
            {editing ? (
              <input
                ref={nameInputRef}
                type='text'
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                onBlur={handleRenameConfirm}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleRenameConfirm()
                  if (e.key === 'Escape') {
                    setEditName(instance.name)
                    setEditing(false)
                  }
                }}
                className='w-full border-violet-400 border-b bg-transparent px-0 py-0 font-semibold text-gray-900 text-sm outline-none'
                data-testid={`skills:input:rename-instance:${instance.id}`}
              />
            ) : (
              <div className='flex items-center gap-1.5'>
                <p
                  className={cn(
                    'font-semibold text-gray-900 text-sm',
                    onOpen && 'cursor-pointer hover:text-violet-600'
                  )}
                  onClick={() => onOpen?.()}
                  title={onOpen ? t('skills.openInstance') : undefined}
                >
                  {instance.name}
                </p>
                {onRename && (
                  <button
                    type='button'
                    onClick={(e) => {
                      e.stopPropagation()
                      setEditName(instance.name)
                      setEditing(true)
                    }}
                    className='shrink-0 rounded p-0.5 text-gray-400 hover:bg-violet-50 hover:text-violet-600'
                    title={t('skills.clickToRename')}
                    data-testid={`skills:button:rename-instance:${instance.id}`}
                  >
                    <Pencil className='h-3.5 w-3.5' />
                  </button>
                )}
              </div>
            )}
            <p className='text-gray-400 text-xs'>
              {t('skills.templateLabel', { name: template.name })}
            </p>
          </div>
        </div>
        <div className='flex items-center gap-1.5'>
          {deployStatus === 'deploying' && (
            <span className='flex shrink-0 items-center gap-1 rounded-full bg-blue-50 px-2 py-0.5 font-medium text-blue-600 text-xs'>
              <Loader2 className='h-3 w-3 animate-spin' />
              {t('skills.statusDeploying')}
            </span>
          )}
          {deployStatus === 'deployed' && (
            <span className='shrink-0 rounded-full bg-green-100 px-2 py-0.5 font-medium text-green-700 text-xs'>
              {t('skills.statusDeployed')}
            </span>
          )}
          {deployStatus === 'failed' && (
            <span className='shrink-0 rounded-full bg-red-100 px-2 py-0.5 font-medium text-red-600 text-xs'>
              {t('skills.statusDeployFailed')}
            </span>
          )}
        </div>
      </div>

      {/* Deployment endpoint */}
      {deployStatus === 'deployed' && instance.deploy?.endpoint && (
        <div className='mb-3 rounded-lg border border-green-200 bg-green-50 px-3 py-2'>
          <div className='mb-1.5 flex items-center justify-between'>
            <div className='flex items-center gap-1.5'>
              <Globe className='h-3.5 w-3.5 text-green-600' />
              <span className='font-medium text-green-700 text-xs'>{t('skills.callCommand')}</span>
            </div>
            <button
              type='button'
              onClick={(e) => {
                e.stopPropagation()
                const params = buildCurlInput(template.parameters?.properties ?? {}, [
                  instance.presetParams,
                  template.presetParams,
                ])
                const cmd = `curl -X POST ${instance.deploy?.endpoint} -H "Content-Type: application/json" -d '${JSON.stringify(params)}'`
                const btn = e.currentTarget
                const showCopied = () => {
                  const original = btn.title
                  btn.title = t('skills.copied')
                  setTimeout(() => {
                    btn.title = original
                  }, 1500)
                }
                copyToClipboard(cmd).then(showCopied)
              }}
              className='shrink-0 rounded p-1 text-green-600 hover:bg-green-100'
              title={t('skills.copyCurl')}
              data-testid={`skills:button:copy-endpoint:${instance.id}`}
            >
              <Copy className='h-3 w-3' />
            </button>
          </div>
          <pre
            className='truncate font-mono text-green-800 text-xs leading-relaxed'
            title={`curl -X POST ${instance.deploy.endpoint} -H "Content-Type: application/json" -d '...'`}
          >
            {`curl -X POST ${instance.deploy.endpoint} -H "Content-Type: application/json" -d '...'`}
          </pre>
        </div>
      )}

      {/* Deployment failure notice */}
      {deployStatus === 'failed' && instance.deploy?.errorMessage && (
        <div className='mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2'>
          <p className='truncate text-red-700 text-xs' title={instance.deploy.errorMessage}>
            {t('skills.deployErrorPrefix', { message: instance.deploy.errorMessage })}
          </p>
        </div>
      )}

      {/* Publish as API toggle */}
      {onTogglePublishApi && (
        <div className='mb-3 flex items-center gap-2'>
          <Switch
            checked={!!instance.publishedAsApi}
            onCheckedChange={onTogglePublishApi}
            data-testid={`skills:switch:publish-api:${instance.id}`}
          />
          <span className='text-sm text-gray-600'>{t('skills.publishApi')}</span>
        </div>
      )}

      {/* API Key management panel — visible when published as API */}
      {instance.publishedAsApi && (
        <ApiKeyPanel
          instanceId={instance.id}
          parameters={template?.parameters as Parameters<typeof ApiKeyPanel>[0]['parameters']}
        />
      )}

      <div className='mt-auto flex items-center justify-end gap-1 text-xs'>
        {/* Deploy button */}
        {onDeploy && deployStatus !== 'deployed' && (
          <PermissionGuard requires='skill:deploy'>
            <button
              type='button'
              onClick={onDeploy}
              disabled={deploying}
              className={cn(
                'flex items-center gap-0.5 rounded-md px-1.5 py-1',
                deploying
                  ? 'cursor-not-allowed text-gray-400'
                  : 'text-emerald-600 hover:bg-emerald-50'
              )}
              data-testid={`skills:button:deploy-instance:${instance.id}`}
            >
              {deploying ? (
                <>
                  <Loader2 className='h-3.5 w-3.5 animate-spin' />
                  {t('skills.deploying')}
                </>
              ) : (
                <>
                  <Rocket className='h-3.5 w-3.5' />
                  {t('skills.deploy')}
                </>
              )}
            </button>
          </PermissionGuard>
        )}
        {/* Undeploy button */}
        {onUndeploy && deployStatus === 'deployed' && (
          <PermissionGuard requires='skill:deploy'>
            <button
              type='button'
              onClick={onUndeploy}
              disabled={undeploying}
              className={cn(
                'flex items-center gap-0.5 rounded-md px-1.5 py-1',
                undeploying
                  ? 'cursor-not-allowed text-gray-400'
                  : 'text-orange-600 hover:bg-orange-50'
              )}
              data-testid={`skills:button:undeploy-instance:${instance.id}`}
            >
              {undeploying ? (
                <>
                  <Loader2 className='h-3.5 w-3.5 animate-spin' />
                  {t('skills.undeploying')}
                </>
              ) : (
                <>
                  <Power className='h-3.5 w-3.5' />
                  {t('skills.undeploy')}
                </>
              )}
            </button>
          </PermissionGuard>
        )}
        {/* Edit button */}
        {onEdit && (
          <button
            type='button'
            onClick={onEdit}
            className='flex items-center gap-0.5 rounded-md px-1.5 py-1 text-violet-600 hover:bg-violet-50'
            data-testid={`skills:button:edit-instance:${instance.id}`}
          >
            <Settings2 className='h-3.5 w-3.5' />
            {t('skills.editTool')}
          </button>
        )}
        {/* Export docker-compose button (dev-studio NFS tools only) */}
        {onExportCompose && template.source === 'dev-studio' && (
          <button
            type='button'
            onClick={onExportCompose}
            className='flex items-center gap-0.5 rounded-md px-1.5 py-1 text-gray-500 hover:bg-gray-50'
            data-testid={`skills:button:export-compose:${instance.id}`}
          >
            <Download className='h-3.5 w-3.5' />
            {t('skills.exportCompose')}
          </button>
        )}
        {/* Delete button */}
        {onDelete && (
          <PermissionGuard requires='skill:delete'>
            <button
              type='button'
              onClick={onDelete}
              className='flex items-center gap-0.5 rounded-md px-1.5 py-1 text-red-500 hover:bg-red-50'
              data-testid={`skills:button:delete-instance:${instance.id}`}
            >
              <Trash2 className='h-3.5 w-3.5' />
              {t('skills.deleteTool')}
            </button>
          </PermissionGuard>
        )}
      </div>
    </div>
  )
}

function EmptyState() {
  const { t } = useTranslation()
  return (
    <div className='mt-6 flex h-64 flex-col items-center justify-center rounded-xl border border-gray-300 border-dashed bg-white'>
      <Package className='mb-3 h-10 w-10 text-gray-300' />
      <p className='font-medium text-gray-900 text-sm'>{t('skills.noInstalledTools')}</p>
      <p className='mt-1 text-gray-400 text-xs'>{t('skills.noInstalledToolsHint')}</p>
    </div>
  )
}

export default function SkillsPage() {
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = useState<Tab>('installed')
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null)
  const [toast, setToast] = useState<{ type: 'success' | 'info'; message: string } | null>(null)
  const [installedSkills, setInstalledSkills] = useState<SkillPackage[]>([])
  const [skillsLoading, setSkillsLoading] = useState(true)
  // const [officialSkills, setOfficialSkills] = useState<SkillPackage[]>([])
  const [aiGeneratorOpen, setAiGeneratorOpen] = useState(false)
  const [devStudioOpen, setDevStudioOpen] = useState(false)
  const [devStudioInitialSessionId, setDevStudioInitialSessionId] = useState<string | null>(null)
  const [devStudioToolId, setDevStudioToolId] = useState<string | undefined>()
  // Drives the dev-studio entry button label: when the operator has a
  // resumable (active) session in the background the single button reads
  // "open dev studio" and reopening returns them to it; otherwise it reads
  // "new tool". Either way the click does resume-or-create — the label just
  // reflects which branch will run. Scoped to toolId=none to match the
  // button's tool-agnostic resume lookup.
  const { sessions: devStudioSessions } = useSessionList()
  const hasResumableDevSession = devStudioSessions.some((s) => s.status === 'active')
  const router = useRouter()
  const searchParams = useSearchParams()
  const [importProjectContext, setImportProjectContext] = useState<GitHubProjectContext | null>(
    null
  )
  const [editingSkill, setEditingSkill] = useState<SkillPackage | null>(null)
  // ApiToolEditor state
  const [apiEditorOpen, setApiEditorOpen] = useState(false)
  const [apiEditorTool, setApiEditorTool] = useState<SkillPackage | undefined>()
  const [apiKeys, setApiKeys] = useState<{ name: string; value: string }[]>([])
  const [apiKeysDialogOpen, setApiKeysDialogOpen] = useState(false)
  const [preloadedModels, setPreloadedModels] = useState<
    {
      id: string
      providerId: string
      displayName: string
      modelName: string | null
      isActive: boolean
    }[]
  >([])
  const [preloadedConnections, setPreloadedConnections] = useState<
    Array<{ id: string; name: string; type: string; config: Record<string, unknown> }>
  >([])

  // Instance-related state
  const [selectedTemplate, setSelectedTemplate] = useState<SkillPackage | null>(null)
  const [instances, setInstances] = useState<ToolInstance[]>([])
  const [instancesLoading, setInstancesLoading] = useState(false)
  const [deployingIds, setDeployingIds] = useState<Set<string>>(new Set())
  const [undeployingIds, setUndeployingIds] = useState<Set<string>>(new Set())
  const [deletingInstance, setDeletingInstance] = useState(false)
  const [deletingTemplate, setDeletingTemplate] = useState(false)
  const [creatingInstance, setCreatingInstance] = useState(false)
  const [instanceCounts, setInstanceCounts] = useState<
    Map<string, { total: number; deployed: number }>
  >(new Map())
  const [deleteInstanceTarget, setDeleteInstanceTarget] = useState<{
    id: string
    name: string
  } | null>(null)
  const [editingInstance, setEditingInstance] = useState<ToolInstance | null>(null)
  /**
   * Instance awaiting a redeploy decision after an env/connection edit. Only
   * set for deployed long-lived tools (opensandbox service / k8s), whose
   * running container snapshots env at deploy time.
   */
  const [redeployPrompt, setRedeployPrompt] = useState<ToolInstance | null>(null)
  const [editingTemplateMeta, setEditingTemplateMeta] = useState<SkillPackage | null>(null)

  // Publish-as-API dialog state (api-kind tools only)
  const [publishDialogTool, setPublishDialogTool] = useState<SkillPackage | null>(null)
  const [publishDialogInstance, setPublishDialogInstance] = useState<ToolInstance | null>(null)
  const [publishDialogLoading, setPublishDialogLoading] = useState(false)
  const [metaDraftName, setMetaDraftName] = useState('')
  const [metaDraftDescription, setMetaDraftDescription] = useState('')
  const [metaSaving, setMetaSaving] = useState(false)

  // .cmapi import dialog state
  const [apiImportDialogOpen, setApiImportDialogOpen] = useState(false)
  const [apiImportPackage, setApiImportPackage] = useState<ApiToolPackage | null>(null)
  /** custom_api connections available for mapping */
  const [apiImportConnections, setApiImportConnections] = useState<
    Array<{ id: string; name: string }>
  >([])
  /** { [requirement.ref]: selectedConnectionId } */
  const [apiImportMapping, setApiImportMapping] = useState<Record<string, string>>({})
  const [apiImporting, setApiImporting] = useState(false)
  const apiImportInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    // loadOfficialTools().then(setOfficialSkills).catch(() => {})

    fetch('/api/employee/models?activeOnly=true')
      .then((r) => r.json())
      .then((data) => {
        if (data.success && data.data?.configs) {
          setPreloadedModels(data.data.configs)
        }
      })
      .catch(() => {})

    // Preload connected system connections
    fetch('/api/employee/connectors?status=connected')
      .then((r) => r.json())
      .then((data) => {
        if (data.success && data.data?.connections) {
          setPreloadedConnections(data.data.connections)
        }
      })
      .catch(() => {})

    fetchInstalledSkills()
  }, [])

  // Open the DevStudioDialog onto an existing session when the URL carries
  // `?devStudio=<sessionId>` — set by the global NotificationCenter cards in
  // (employee)/components/notifications/notification-center.tsx. After
  // opening we strip the param so a manual close + reopen creates a fresh
  // session instead of pivoting back to the deep-linked one.
  useEffect(() => {
    const id = searchParams.get('devStudio')
    if (!id) return
    setDevStudioInitialSessionId(id)
    setDevStudioOpen(true)
    const next = new URLSearchParams(searchParams.toString())
    next.delete('devStudio')
    const query = next.toString()
    router.replace(query ? `/skills?${query}` : '/skills')
  }, [searchParams, router])

  const fetchInstalledSkills = () => {
    fetch('/api/employee/skills')
      .then((r) => r.json())
      .then((data: { skills: SkillPackage[] }) => {
        setInstalledSkills(data.skills ?? [])
      })
      .catch(() => {})
      .finally(() => setSkillsLoading(false))
  }

  // Load instance counts for all templates (batch query)
  useEffect(() => {
    if (installedSkills.length === 0) return

    fetch('/api/employee/skills/instances?counts=true')
      .then((r) => r.json())
      .then((data) => {
        if (data.success && data.counts) {
          const counts = new Map<string, { total: number; deployed: number }>()
          for (const [templateId, c] of Object.entries(data.counts)) {
            counts.set(templateId, c as { total: number; deployed: number })
          }
          setInstanceCounts(counts)
        }
      })
      .catch(() => {})
  }, [installedSkills])

  // Load API Key config (from database)
  useEffect(() => {
    fetch('/api/employee/tools/api-keys')
      .then((r) => r.json())
      .then((data) => {
        if (data.success && data.keys) setApiKeys(data.keys)
      })
      .catch(() => {})
  }, [])

  const showToast = (type: 'success' | 'info', message: string) => {
    setToast({ type, message })
    setTimeout(() => setToast(null), 3000)
  }

  // Load instance list for template
  const loadInstances = useCallback(async (templateId: string) => {
    setInstancesLoading(true)
    try {
      const res = await fetch(`/api/employee/skills/instances?templateId=${templateId}`)
      if (!res.ok) throw new Error(t('skills.loadFailed'))
      const data = await res.json()
      setInstances(data.instances ?? [])
    } catch {
      showToast('info', t('skills.loadInstancesFailed'))
    } finally {
      setInstancesLoading(false)
    }
  }, [])

  // Enter instance list
  const handleTemplateClick = (skill: SkillPackage) => {
    // OpenClaw-style templates have no code (external service); still allow instance management.
    const ct = skill.connectorType
    const isOpenclaw =
      typeof ct === 'object' && ct !== null && (ct as { type?: string }).type === 'openclaw'
    if (!skill.code && !isOpenclaw && skill.source !== 'dev-studio') return
    setSelectedTemplate(skill)
    loadInstances(skill.id)
  }

  // Return to template list
  const handleBackToTemplates = () => {
    setSelectedTemplate(null)
    setInstances([])
    // Refresh instance counts
    fetchInstalledSkills()
  }

  // Create instance
  const handleCreateInstance = async () => {
    if (!selectedTemplate || creatingInstance) return
    setCreatingInstance(true)
    try {
      const res = await fetch('/api/employee/skills/instances', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          templateId: selectedTemplate.id,
          presetParams: selectedTemplate.presetParams,
          envVars: selectedTemplate.envVars,
        }),
      })
      if (!res.ok) {
        showToast('info', t('skills.createInstanceFailed'))
        return
      }
      const data = await res.json()
      setInstances((prev) => [data.instance, ...prev])
      // If template requires connection, auto-open editor to select one
      if (selectedTemplate.connectorType) {
        setEditingInstance(data.instance as ToolInstance)
        showToast('success', t('skills.instanceCreatedSelectConn'))
      } else {
        showToast('success', t('skills.instanceCreated', { name: data.instance.name }))
      }
    } catch {
      showToast('info', t('skills.createInstanceFailed'))
    } finally {
      setCreatingInstance(false)
    }
  }

  // Deploy instance
  const handleDeployInstance = async (inst: ToolInstance) => {
    // Merge env vars: prefer instance, fallback to template
    const effectiveEnvVars =
      inst.envVars && inst.envVars.length > 0 ? inst.envVars : selectedTemplate?.envVars
    if (effectiveEnvVars && effectiveEnvVars.length > 0) {
      const emptyEnvs = effectiveEnvVars.filter((e) => !String(e.value ?? '').trim())
      if (emptyEnvs.length > 0) {
        showToast(
          'info',
          t('skills.configEnvFirst', { names: emptyEnvs.map((e) => e.name).join(', ') })
        )
        return
      }
    }

    setDeployingIds((prev) => new Set(prev).add(inst.id))
    setInstances((prev) =>
      prev.map((i) => (i.id === inst.id ? { ...i, deploy: { status: 'deploying' as const } } : i))
    )
    try {
      const res = await fetch(`/api/employee/skills/instances/${inst.id}/deploy`, {
        method: 'POST',
      })
      const data = await res.json()
      if (data.success) {
        setInstances((prev) =>
          prev.map((i) => (i.id === inst.id ? { ...i, deploy: data.deploy as DeployInfo } : i))
        )
        showToast('success', t('skills.deployed', { name: inst.name }))
      } else {
        // API shape: { success:false, message:<i18n-key>, detail?:<actual-error> }
        // (see lib/api/response.ts apiErr + instances/[id]/deploy/route.ts which sets extra.detail)
        const errMsg = data.detail || (data.message ? t(data.message) : null) || 'unknown error'
        setInstances((prev) =>
          prev.map((i) =>
            i.id === inst.id
              ? { ...i, deploy: { status: 'failed' as const, errorMessage: errMsg } }
              : i
          )
        )
        showToast('info', t('skills.deployFailed', { error: errMsg }))
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setInstances((prev) =>
        prev.map((i) =>
          i.id === inst.id ? { ...i, deploy: { status: 'failed' as const, errorMessage: msg } } : i
        )
      )
      showToast('info', t('skills.deployFailed', { error: msg }))
    } finally {
      setDeployingIds((prev) => {
        const next = new Set(prev)
        next.delete(inst.id)
        return next
      })
    }
  }

  // Undeploy instance
  const handleUndeployInstance = async (inst: ToolInstance) => {
    setUndeployingIds((prev) => new Set(prev).add(inst.id))
    try {
      const res = await fetch(`/api/employee/skills/instances/${inst.id}/deploy`, {
        method: 'DELETE',
      })
      const data = await res.json()
      if (data.success) {
        setInstances((prev) =>
          prev.map((i) =>
            i.id === inst.id ? { ...i, deploy: { status: 'not_deployed' as const } } : i
          )
        )
        showToast('info', t('skills.undeployed', { name: inst.name }))
      } else {
        const errMsg = data.detail || (data.message ? t(data.message) : null) || 'unknown error'
        showToast('info', t('skills.undeployFailed', { error: errMsg }))
      }
    } catch (err) {
      showToast(
        'info',
        t('skills.undeployFailed', { error: err instanceof Error ? err.message : String(err) })
      )
    } finally {
      setUndeployingIds((prev) => {
        const next = new Set(prev)
        next.delete(inst.id)
        return next
      })
    }
  }

  // Rename instance
  const handleRenameInstance = async (inst: ToolInstance, newName: string) => {
    const res = await fetch(`/api/employee/skills/instances/${inst.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName }),
    })
    if (!res.ok) {
      showToast('info', t('skills.renameFailed'))
      return
    }
    setInstances((prev) => prev.map((i) => (i.id === inst.id ? { ...i, name: newName } : i)))
    showToast('success', t('skills.renamedTo', { name: newName }))
  }

  // Toggle publish-as-API for an instance
  const handleTogglePublishApi = async (inst: ToolInstance, checked: boolean) => {
    // Optimistically update UI
    setInstances((prev) =>
      prev.map((i) => (i.id === inst.id ? { ...i, publishedAsApi: checked } : i))
    )
    try {
      const res = await fetch(`/api/employee/skills/instances/${inst.id}/publish-api`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ publishedAsApi: checked }),
      })
      if (!res.ok) {
        // Revert on failure
        setInstances((prev) =>
          prev.map((i) => (i.id === inst.id ? { ...i, publishedAsApi: !checked } : i))
        )
        showToast('info', t('skills.saveFailed'))
      }
    } catch {
      setInstances((prev) =>
        prev.map((i) => (i.id === inst.id ? { ...i, publishedAsApi: !checked } : i))
      )
      showToast('info', t('skills.saveFailed'))
    }
  }

  // Open publish-as-API dialog for an api-kind template.
  // Fetches the existing instance (or creates one if none exist), then shows the dialog.
  const handleOpenPublishDialog = async (skill: SkillPackage) => {
    setPublishDialogTool(skill)
    setPublishDialogInstance(null)
    setPublishDialogLoading(true)
    try {
      // Fetch existing instances for this template
      const listRes = await fetch(
        `/api/employee/skills/instances?templateId=${encodeURIComponent(skill.id)}`
      )
      if (!listRes.ok) throw new Error('fetch-instances-failed')
      const listData = await listRes.json()
      const existing = (listData.instances ?? []) as ToolInstance[]
      if (existing.length > 0) {
        setPublishDialogInstance(existing[0])
        return
      }
      // No instance yet — create a default one
      const createRes = await fetch('/api/employee/skills/instances', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ templateId: skill.id }),
      })
      if (!createRes.ok) throw new Error('create-instance-failed')
      const createData = await createRes.json()
      setPublishDialogInstance(createData.instance as ToolInstance)
      // Refresh instance counts in the background
      fetchInstalledSkills()
    } catch {
      showToast('info', t('skills.createInstanceFailed'))
      setPublishDialogTool(null)
    } finally {
      setPublishDialogLoading(false)
    }
  }

  // Toggle publishedAsApi for the instance shown in the publish dialog
  const handlePublishDialogToggle = async (checked: boolean) => {
    if (!publishDialogInstance) return
    const prev = publishDialogInstance.publishedAsApi
    // Optimistic update
    setPublishDialogInstance((i) => (i ? { ...i, publishedAsApi: checked } : i))
    try {
      const res = await fetch(
        `/api/employee/skills/instances/${publishDialogInstance.id}/publish-api`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ publishedAsApi: checked }),
        }
      )
      if (!res.ok) {
        // Revert on failure
        setPublishDialogInstance((i) => (i ? { ...i, publishedAsApi: prev } : i))
        showToast('info', t('skills.saveFailed'))
      }
    } catch {
      setPublishDialogInstance((i) => (i ? { ...i, publishedAsApi: prev } : i))
      showToast('info', t('skills.saveFailed'))
    }
  }

  // Delete instance
  const confirmDeleteInstance = async () => {
    if (!deleteInstanceTarget) return
    const { id, name } = deleteInstanceTarget
    setDeletingInstance(true)
    try {
      const res = await fetch(`/api/employee/skills/instances/${id}`, { method: 'DELETE' })
      if (!res.ok) {
        showToast('info', t('skills.deleteInstanceFailed'))
        return
      }
      setInstances((prev) => prev.filter((i) => i.id !== id))
      showToast('info', t('skills.instanceDeleted', { name }))
    } catch {
      showToast('info', t('skills.deleteInstanceFailed'))
    } finally {
      setDeletingInstance(false)
      setDeleteInstanceTarget(null)
    }
  }

  // Official tools tab hidden, related logic comments retained
  // const getOfficialCardProps = (official: SkillPackage) => { ... }

  // Installed tab: template card props
  const getInstalledCardProps = (installed: SkillPackage) => {
    const ct = installed.connectorType
    const isOpenclaw =
      typeof ct === 'object' && ct !== null && (ct as { type?: string }).type === 'openclaw'
    const isApiTool = installed.kind === 'api'
    // API tools have no instance-list view; all other clickable tools do.
    const clickable = !isApiTool && (installed.code || isOpenclaw || installed.source === 'dev-studio')
    return {
      onUninstall: () => setDeleteTarget({ id: installed.id, name: installed.name }),
      onClick: clickable ? () => handleTemplateClick(installed) : undefined,
      onEditMeta: isApiTool
        ? undefined
        : () => {
            setEditingTemplateMeta(installed)
            setMetaDraftName(installed.name)
            setMetaDraftDescription(installed.description ?? '')
          },
      // For api tools, expose a full editor button instead of meta-only pencil
      onEdit: isApiTool
        ? () => {
            setApiEditorTool(installed)
            setApiEditorOpen(true)
          }
        : undefined,
      // For api tools, expose a publish-as-API button
      onPublish: isApiTool ? () => handleOpenPublishDialog(installed) : undefined,
      onDevelop:
        installed.source === 'dev-studio'
          ? () => {
              setDevStudioToolId(installed.id)
              setDevStudioOpen(true)
            }
          : undefined,
      onToggleForwardIdentity: (next: boolean) => handleToggleForwardIdentity(installed, next),
    }
  }

  /**
   * Toggle a tool template's forward-identity flag directly from its card.
   * Optimistically updates the list, persists via the skills CRUD route (which
   * writes tools.forward_identity), and reverts on failure.
   */
  const handleToggleForwardIdentity = async (skill: SkillPackage, next: boolean) => {
    const updated: SkillPackage = { ...skill, forwardIdentity: next }
    setInstalledSkills((prev) => prev.map((s) => (s.id === skill.id ? updated : s)))
    try {
      const res = await fetch('/api/employee/skills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skill: updated }),
      })
      if (!res.ok) throw new Error('save failed')
    } catch {
      setInstalledSkills((prev) => prev.map((s) => (s.id === skill.id ? skill : s)))
      showToast('info', t('skills.saveFailed'))
    }
  }

  const handleSaveTemplateMeta = async () => {
    if (!editingTemplateMeta || metaSaving) return
    const name = metaDraftName.trim()
    if (!name) {
      showToast('info', t('skills.metaSaveFailed'))
      return
    }
    const description = metaDraftDescription
    const updated: SkillPackage = { ...editingTemplateMeta, name, description }
    setMetaSaving(true)
    try {
      const res = await fetch('/api/employee/skills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skill: updated }),
      })
      if (!res.ok) {
        showToast('info', t('skills.metaSaveFailed'))
        return
      }
      setInstalledSkills((prev) => prev.map((s) => (s.id === updated.id ? updated : s)))
      if (selectedTemplate?.id === updated.id) {
        setSelectedTemplate(updated)
      }
      setEditingTemplateMeta(null)
      showToast('success', t('skills.metaSaved'))
    } catch {
      showToast('info', t('skills.metaSaveFailed'))
    } finally {
      setMetaSaving(false)
    }
  }

  // handleUpgrade depends on official tools, not needed after hiding
  // const handleUpgrade = async (official: SkillPackage) => { ... }

  // Export template via BFF route (handles both inline-code and .cmtool)
  const handleExportTemplate = async (skill: SkillPackage) => {
    try {
      const res = await fetch(`/api/employee/skills/${skill.id}/export`)
      if (!res.ok) {
        showToast('info', t('skills.exportFailed'))
        return
      }
      const blob = await res.blob()
      const disposition = res.headers.get('Content-Disposition') ?? ''
      const filenameMatch = disposition.match(/filename="?([^"]+)"?/)
      const filename = filenameMatch ? decodeURIComponent(filenameMatch[1]) : `${skill.name}.zip`
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      a.click()
      URL.revokeObjectURL(url)
      showToast('success', t('skills.exported'))
    } catch {
      showToast('info', t('skills.exportFailed'))
    }
  }

  // Export instance as standalone docker-compose package
  const handleExportInstance = async (instanceId: string, instanceName: string) => {
    try {
      const res = await fetch(`/api/employee/skills/instances/${instanceId}/export`)
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        showToast('info', text || t('skills.exportFailed'))
        return
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${instanceName}-docker.zip`
      a.click()
      URL.revokeObjectURL(url)
      showToast('success', t('skills.exported'))
    } catch {
      showToast('info', t('skills.exportFailed'))
    }
  }

  // Import .md/.txt -> extract content, feed to AI generator
  const handleImportTextFile = async (file: File) => {
    try {
      const raw = await file.text()
      const text = raw.slice(0, 3000)
      // Try to extract name from first # heading in Markdown
      const titleMatch = text.match(/^#\s+(.+)/m)
      const projectName = titleMatch?.[1]?.trim() || file.name.replace(/\.(md|txt)$/, '')
      const ctx: GitHubProjectContext = {
        projectName,
        language: 'javascript',
        readme: text,
        source: 'markdown',
      }
      setImportProjectContext(ctx)
      setAiGeneratorOpen(true)
    } catch {
      showToast('info', t('skills.fileReadFailed'))
    }
  }

  // Import template zip
  const handleImportTemplate = async (file: File) => {
    try {
      const zip = await JSZip.loadAsync(file)

      // ---- Path A: CrewMeld format (manifest.json + tool.js/tool.py)----
      const manifestFile = zip.file('manifest.json')
      if (manifestFile) {
        const manifest = JSON.parse(await manifestFile.async('text')) as Record<string, unknown>
        if (!manifest.name) {
          showToast('info', t('skills.invalidToolPkg'))
          return
        }

        let code: string | undefined
        let detectedLang: 'javascript' | 'python' = 'javascript'
        const jsFile = zip.file('tool.js')
        const pyFile = zip.file('tool.py')
        if (jsFile) {
          code = await jsFile.async('text')
        } else if (pyFile) {
          code = await pyFile.async('text')
          detectedLang = 'python'
        }

        // Exported zip with _crewmeld_export -> directly restore, skip AI generation
        if (manifest._crewmeld_export && code) {
          const skill: SkillPackage = {
            id: `ai-tool-${Date.now()}`,
            name: manifest.name as string,
            description: (manifest.description as string) ?? '',
            version: (manifest.version as string) ?? '1.0.0',
            size: '0',
            uploadedAt: new Date().toISOString(),
            source: 'custom',
            category: (manifest.category as string) ?? t('skills.generatorCategoryAI'),
            author: (manifest.author as string) ?? '',
            language: (manifest.language as 'javascript' | 'python') ?? detectedLang,
            parameters: manifest.parameters as SkillPackage['parameters'],
            presetParams: manifest.presetParams as Record<string, string> | undefined,
            envVars: manifest.envVars as SkillPackage['envVars'],
            code,
            apiDoc: (manifest.apiDoc as string) ?? undefined,
            connectorType: (manifest.connectorType as string) ?? undefined,
          }
          const res = await fetch('/api/employee/skills', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ skill }),
          })
          if (!res.ok) {
            showToast('info', t('skills.saveFailed'))
            return
          }
          setInstalledSkills((prev) => [skill, ...prev])
          showToast('success', t('skills.importedDirectly', { name: skill.name }))
          return
        }

        // Zip without flag -> send to AI for rewriting
        const ctx: GitHubProjectContext = {
          projectName: manifest.name as string,
          language: detectedLang,
          source: 'skill-zip',
          readme: (manifest.description as string) ?? '',
          originalCode: code?.slice(0, 3000),
          originalParameters: manifest.parameters as Record<string, unknown>,
        }
        setImportProjectContext(ctx)
        setAiGeneratorOpen(true)
        return
      }

      // ---- Path B: GitHub project zip -> parse and feed to AI ----
      const ctx = await parseGitHubZip(zip)
      if (!ctx) {
        showToast('info', t('skills.unrecognizedFormat'))
        return
      }
      setImportProjectContext(ctx)
      setAiGeneratorOpen(true)
    } catch {
      showToast('info', t('skills.importFileFailed'))
    }
  }

  /** Parse project context from GitHub zip */
  async function parseGitHubZip(zip: JSZip): Promise<GitHubProjectContext | null> {
    // GitHub zip usually has a top-level dir: repo-name-main/
    const allPaths = Object.keys(zip.files)
    const topDir =
      allPaths.find((p) => p.endsWith('/') && p.split('/').filter(Boolean).length === 1) ?? ''

    // Helper: read zip file, auto-prepend top-level dir prefix
    async function readFile(relativePath: string, maxLen = 5000): Promise<string | undefined> {
      const f = zip.file(topDir + relativePath) ?? zip.file(relativePath)
      if (!f || f.dir) return undefined
      const text = await f.async('text')
      return text.slice(0, maxLen)
    }

    // Detect project type
    const pyprojectToml = await readFile('pyproject.toml')
    const setupPy = await readFile('setup.py')
    const packageJson = await readFile('package.json')
    const requirementsTxt = await readFile('requirements.txt')

    const isPython = !!(pyprojectToml || setupPy || requirementsTxt)
    const isJs = !!packageJson && !isPython

    if (!isPython && !isJs) return null

    // Project name
    let projectName = ''
    if (packageJson) {
      try {
        projectName = JSON.parse(packageJson).name ?? ''
      } catch {}
    }
    if (!projectName && pyprojectToml) {
      const nameMatch = pyprojectToml.match(/^name\s*=\s*"([^"]+)"/m)
      if (nameMatch) projectName = nameMatch[1]
    }
    if (!projectName && topDir) {
      projectName = topDir.replace(/[-_]main\/?$/, '').replace(/\/$/, '')
    }

    // Dependency files
    let depsFile: string | undefined
    let depsFileName: string | undefined
    if (pyprojectToml) {
      depsFile = pyprojectToml
      depsFileName = 'pyproject.toml'
    } else if (setupPy) {
      depsFile = setupPy
      depsFileName = 'setup.py'
    } else if (packageJson) {
      depsFile = packageJson
      depsFileName = 'package.json'
    }
    if (requirementsTxt && isPython) {
      depsFile = (depsFile ? `${depsFile}\n\n--- requirements.txt ---\n` : '') + requirementsTxt
      depsFileName = depsFileName ? `${depsFileName} + requirements.txt` : 'requirements.txt'
    }

    // README
    const readme = (await readFile('README.md', 3000)) ?? (await readFile('readme.md', 3000))

    // Example code
    const examples: Array<{ name: string; content: string }> = []
    const examplePattern = isPython ? /^examples?\//i : /^examples?\//i
    for (const filePath of allPaths) {
      if (examples.length >= 2) break
      const relative = topDir ? filePath.replace(topDir, '') : filePath
      if (!examplePattern.test(relative)) continue
      if (isPython && !relative.endsWith('.py')) continue
      if (isJs && !relative.match(/\.(js|ts|mjs)$/)) continue
      const f = zip.file(filePath)
      if (!f || f.dir) continue
      const content = await f.async('text')
      examples.push({ name: relative, content: content.slice(0, 1500) })
    }

    // Entry point file
    let entryPoint: string | undefined
    let entryPointName: string | undefined
    if (isPython) {
      // Try packagename/__init__.py
      const pkgName = projectName.replace(/-/g, '_')
      entryPoint = await readFile(`${pkgName}/__init__.py`, 1500)
      if (entryPoint) entryPointName = `${pkgName}/__init__.py`
      if (!entryPoint) {
        entryPoint = await readFile('src/__init__.py', 1500)
        if (entryPoint) entryPointName = 'src/__init__.py'
      }
    } else {
      entryPoint =
        (await readFile('index.js', 1500)) ??
        (await readFile('src/index.js', 1500)) ??
        (await readFile('src/index.ts', 1500))
      if (entryPoint) entryPointName = 'index.js'
    }

    return {
      projectName: projectName || 'unknown-project',
      language: isPython ? 'python' : 'javascript',
      readme,
      depsFile,
      depsFileName,
      examples: examples.length > 0 ? examples : undefined,
      entryPoint,
      entryPointName,
    }
  }

  // Import a .cmtool (dev-studio workspace zip) — server uploads to MinIO + DB
  const handleImportCmtool = async (file: File) => {
    try {
      const form = new FormData()
      form.append('file', file)
      const res = await fetch('/api/employee/skills/import-cmtool', {
        method: 'POST',
        body: form,
      })
      const body = (await res.json().catch(() => null)) as {
        success?: boolean
        skill?: SkillPackage
      } | null
      if (!res.ok || !body?.success || !body.skill) {
        showToast('info', t('skills.importFileFailed'))
        return
      }
      setInstalledSkills((prev) => [body.skill as SkillPackage, ...prev])
      showToast('success', t('skills.importedDirectly', { name: body.skill.name }))
    } catch {
      showToast('info', t('skills.importFileFailed'))
    }
  }

  // Handle .cmapi file pick: parse, fetch connections, open mapping dialog
  const handleImportCmapiFile = async (file: File) => {
    let parsed: unknown
    try {
      const text = await file.text()
      parsed = JSON.parse(text)
    } catch {
      showToast('info', '文件读取失败，请确认是有效的 .cmapi 文件')
      return
    }

    // Minimal client-side validation before opening dialog
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      (parsed as Record<string, unknown>)['_crewmeld_api_tool'] !== true ||
      !(parsed as Record<string, unknown>)['apiSpec']
    ) {
      showToast('info', '无效的 .cmapi 文件：缺少必要字段')
      return
    }

    const pkg = parsed as ApiToolPackage

    // Fetch custom_api connections for the mapping dropdowns
    let connections: Array<{ id: string; name: string }> = []
    try {
      const res = await fetch('/api/employee/connectors?type=custom_api')
      const data = (await res.json()) as {
        success?: boolean
        data?: { connections?: Array<{ id: string; name: string }> }
      }
      if (data.success && data.data?.connections) {
        connections = data.data.connections
      }
    } catch {
      // Non-fatal: show empty dropdowns
    }

    // Pre-fill mapping: match requirement name to connection name (case-insensitive)
    const defaultMapping: Record<string, string> = {}
    for (const req of pkg.connectionRequirements ?? []) {
      const match = connections.find(
        (c) => c.name.toLowerCase() === req.name.toLowerCase()
      )
      if (match) defaultMapping[req.ref] = match.id
    }

    setApiImportPackage(pkg)
    setApiImportConnections(connections)
    setApiImportMapping(defaultMapping)
    setApiImportDialogOpen(true)
  }

  // Submit .cmapi import with connection mapping
  const handleConfirmApiImport = async () => {
    if (!apiImportPackage || apiImporting) return
    setApiImporting(true)
    try {
      const res = await fetch('/api/employee/skills/import-api', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          package: apiImportPackage,
          mapping: apiImportMapping,
        }),
      })
      const body = (await res.json().catch(() => null)) as {
        success?: boolean
        data?: { toolId?: string; name?: string }
        message?: string
      } | null
      if (!res.ok || !body?.success) {
        showToast('info', `导入失败：${body?.message ?? res.statusText}`)
        return
      }
      // Refresh skills list to show the newly imported tool
      fetchInstalledSkills()
      setApiImportDialogOpen(false)
      setApiImportPackage(null)
      showToast('success', `API 工具「${body?.data?.name ?? apiImportPackage.name}」已成功导入`)
    } catch (err) {
      showToast('info', `导入失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setApiImporting(false)
    }
  }

  // Unified import entry: route by file extension
  const importInputRef = useRef<HTMLInputElement>(null)
  const handleImportFile = (file: File) => {
    const ext = file.name.split('.').pop()?.toLowerCase()
    if (ext === 'zip') {
      handleImportTemplate(file)
    } else if (ext === 'cmtool') {
      handleImportCmtool(file)
    } else if (ext === 'md' || ext === 'txt') {
      handleImportTextFile(file)
    } else {
      showToast('info', t('skills.onlyZipMdTxt'))
    }
  }

  const confirmDelete = async () => {
    if (!deleteTarget) return
    const { id, name } = deleteTarget
    setDeletingTemplate(true)
    try {
      const res = await fetch(`/api/employee/skills/${id}`, { method: 'DELETE' })
      if (!res.ok) {
        showToast('info', t('skills.uninstallFailed'))
        return
      }
      setInstalledSkills((prev) => prev.filter((s) => s.id !== id))
      // If viewing this template instance list, go back to templates
      if (selectedTemplate?.id === id) {
        setSelectedTemplate(null)
        setInstances([])
      }
      showToast('info', t('skills.uninstalled', { name }))
    } catch {
      showToast('info', t('skills.uninstallFailed'))
    } finally {
      setDeletingTemplate(false)
      setDeleteTarget(null)
    }
  }

  return (
    <div>
      <div className='mb-6 flex items-start justify-between'>
        <div>
          {selectedTemplate ? (
            <div className='flex items-center gap-3'>
              <button
                type='button'
                onClick={handleBackToTemplates}
                className='flex items-center gap-1 rounded-lg p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-700'
                data-testid='skills:button:back-to-templates'
              >
                <ChevronLeft className='h-5 w-5' />
              </button>
              <div>
                <h1 className='font-bold text-2xl text-gray-900'>{selectedTemplate.name}</h1>
                <p className='mt-1 text-gray-500 text-sm'>{t('skills.instanceSubtitle')}</p>
              </div>
            </div>
          ) : (
            <div>
              <h1 className='font-bold text-2xl text-gray-900'>{t('skills.tool')}</h1>
              <p className='mt-1 text-gray-500 text-sm'>{t('skills.toolSubtitle')}</p>
            </div>
          )}
        </div>
        <div className='flex items-center gap-2'>
          {selectedTemplate ? (
            <Button
              onClick={handleCreateInstance}
              disabled={creatingInstance}
              className='bg-violet-600 hover:bg-violet-700'
              data-testid='skills:button:create-instance'
            >
              {creatingInstance ? (
                <>
                  <Loader2 className='mr-2 h-4 w-4 animate-spin' />
                  {t('skills.creating')}
                </>
              ) : (
                <>
                  <Plus className='mr-2 h-4 w-4' />
                  {t('skills.createInstance')}
                </>
              )}
            </Button>
          ) : (
            <>
              <PermissionGuard requires='skill:create'>
                <Button
                  variant='outline'
                  onClick={() => importInputRef.current?.click()}
                  data-testid='skills:button:import'
                >
                  <Download className='mr-2 h-4 w-4' />
                  {t('skills.importTool')}
                </Button>
              </PermissionGuard>
              <input
                ref={importInputRef}
                type='file'
                accept='.zip,.cmtool,.md,.txt'
                className='hidden'
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  if (file) handleImportFile(file)
                  e.target.value = ''
                }}
              />
              <PermissionGuard requires='skill:create'>
                <Button
                  variant='outline'
                  onClick={() => apiImportInputRef.current?.click()}
                  data-testid='skills:button:import-api'
                >
                  <Download className='mr-2 h-4 w-4' />
                  导入 API 工具
                </Button>
              </PermissionGuard>
              <input
                ref={apiImportInputRef}
                type='file'
                accept='.cmapi,application/json'
                className='hidden'
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  if (file) handleImportCmapiFile(file)
                  e.target.value = ''
                }}
              />
              <Button
                variant='outline'
                onClick={() => setApiKeysDialogOpen(true)}
                data-testid='skills:button:api-keys-config'
              >
                <KeyRound className='mr-2 h-4 w-4' />
                {t('skills.config')}
              </Button>
              <PermissionGuard requires='skill:create'>
                <Button
                  variant='outline'
                  onClick={() => {
                    setApiEditorTool(undefined)
                    setApiEditorOpen(true)
                  }}
                  data-testid='skills:button:create-api-tool'
                >
                  <Plus className='mr-2 h-4 w-4' />
                  新建 API 工具
                </Button>
              </PermissionGuard>
              <PermissionGuard requires='skill:create'>
                <Button
                  onClick={() => setDevStudioOpen(true)}
                  className='bg-violet-600 hover:bg-violet-700'
                  data-testid='skills:open-dev-studio'
                >
                  {hasResumableDevSession ? (
                    <Sparkles className='mr-2 h-4 w-4' />
                  ) : (
                    <Plus className='mr-2 h-4 w-4' />
                  )}
                  {hasResumableDevSession ? t('skills.openDevStudio') : t('skills.createTool')}
                </Button>
              </PermissionGuard>
            </>
          )}
        </div>
      </div>

      <DevStudioDialog
        open={devStudioOpen}
        onClose={() => {
          setDevStudioOpen(false)
          setDevStudioInitialSessionId(null)
          setDevStudioToolId(undefined)
          fetchInstalledSkills()
        }}
        initialSessionId={devStudioInitialSessionId}
        toolId={devStudioToolId}
      />

      {/* Instance list view */}
      {selectedTemplate ? (
        <div>
          {instancesLoading ? (
            <div className='mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3'>
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className='h-48 animate-pulse rounded-xl bg-gray-200' />
              ))}
            </div>
          ) : instances.length === 0 ? (
            <div className='mt-6 flex h-64 flex-col items-center justify-center rounded-xl border border-gray-300 border-dashed bg-white'>
              <Layers className='mb-3 h-10 w-10 text-gray-300' />
              <p className='font-medium text-gray-900 text-sm'>{t('skills.noInstances')}</p>
              <p className='mt-1 text-gray-400 text-xs'>{t('skills.noInstancesHint')}</p>
            </div>
          ) : (
            <div
              className='mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3'
              data-testid='skills:instance-grid'
            >
              {instances.map((inst) => (
                <InstanceCard
                  key={inst.id}
                  instance={inst}
                  template={selectedTemplate}
                  onDeploy={() => handleDeployInstance(inst)}
                  onUndeploy={() => handleUndeployInstance(inst)}
                  onOpen={() => setEditingInstance(inst)}
                  onEdit={() => setEditingInstance(inst)}
                  onRename={(name) => handleRenameInstance(inst, name)}
                  onDelete={() => setDeleteInstanceTarget({ id: inst.id, name: inst.name })}
                  onExportCompose={() => handleExportInstance(inst.id, inst.name)}
                  deploying={deployingIds.has(inst.id)}
                  undeploying={undeployingIds.has(inst.id)}
                  onTogglePublishApi={(checked) => handleTogglePublishApi(inst, checked)}
                />
              ))}
            </div>
          )}
        </div>
      ) : (
        <>
          {/* Tabs chip temporarily hidden — only one tab remains, restore when adding official tab back */}
          {false && (
            <div className='flex w-fit gap-1 rounded-xl border border-gray-200 bg-gray-50 p-1'>
              {TABS_META.map(({ key, tKey, icon: Icon }) => (
                <button
                  key={key}
                  type='button'
                  onClick={() => setActiveTab(key)}
                  className={cn(
                    'flex items-center gap-2 rounded-lg px-4 py-2 font-medium text-sm transition-colors',
                    activeTab === key
                      ? 'bg-white text-gray-900 shadow-sm'
                      : 'text-gray-500 hover:text-gray-700'
                  )}
                  data-testid={`skills:tab:${key}`}
                >
                  <Icon className='h-4 w-4' />
                  {t(tKey)}
                </button>
              ))}
            </div>
          )}

          {/* Skill grid */}
          {activeTab === 'installed' && skillsLoading ? (
            <div className='mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3'>
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className='h-40 animate-pulse rounded-xl bg-gray-200' />
              ))}
            </div>
          ) : activeTab === 'installed' && installedSkills.length === 0 ? (
            <EmptyState />
          ) : (
            <div
              className='mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3'
              data-testid='skills:grid'
            >
              {installedSkills.map((skill) => {
                const props = getInstalledCardProps(skill)
                const counts = instanceCounts.get(skill.id)
                return (
                  <TemplateCard
                    key={skill.id}
                    skill={skill}
                    instanceCount={counts?.total ?? 0}
                    deployedCount={counts?.deployed ?? 0}
                    onExport={() => handleExportTemplate(skill)}
                    {...props}
                  />
                )
              })}
              {/* Official tools list hidden */}
              {/* officialSkills.map((skill) => { ... }) */}
            </div>
          )}
        </>
      )}

      {/* Toast */}
      {toast && (
        <div
          className={cn(
            '-translate-x-1/2 fixed top-16 left-1/2 z-50 flex items-center gap-3 rounded-xl border px-5 py-3 shadow-lg',
            toast.type === 'success'
              ? 'border-green-200 bg-green-50 text-green-800'
              : 'border-blue-200 bg-blue-50 text-blue-800'
          )}
        >
          {toast.type === 'success' ? (
            <CheckCircle2 className='h-4 w-4 shrink-0' />
          ) : (
            <Info className='h-4 w-4 shrink-0' />
          )}
          <span className='font-medium text-sm'>{toast.message}</span>
        </div>
      )}

      {/* AI tool generation dialog */}
      <AiToolGenerator
        open={aiGeneratorOpen}
        onClose={() => {
          setAiGeneratorOpen(false)
          setImportProjectContext(null)
        }}
        apiKeys={apiKeys}
        preloadedModels={preloadedModels}
        preloadedConnections={preloadedConnections}
        importProjectContext={importProjectContext}
        onCreated={async (tool) => {
          // Separate secret from parameters: secret -> envVars + keep in properties
          // (so server-side wrap can still destructure `password` etc. from __merged__).
          // The `secret:true` flag keeps the editor form from prompting for them.
          const secretEnvVars: Array<{ name: string; value: string }> = []
          let cleanedParameters = tool.parameters
          if (tool.parameters?.properties) {
            const normalProps: typeof tool.parameters.properties = {}
            const normalRequired: string[] = []
            for (const [key, prop] of Object.entries(tool.parameters.properties)) {
              if (prop.secret) {
                // Prefer the param's mapped envName (e.g. CONN_PASSWORD when bound to
                // a connection). Fall back to CREWMELD_<KEY> for standalone secrets.
                const envName = prop.envName ?? skillEnvName(key)
                const testVal = tool.testParams?.[key]
                const apiVal =
                  apiKeys.find((k) => k.name.toLowerCase().includes(key.toLowerCase()) && k.value)
                    ?.value ?? apiKeys.find((k) => k.name && k.value)?.value
                secretEnvVars.push({ name: envName, value: testVal || apiVal || '' })
                // Ensure properties retains the secret entry (with its envName) so
                // the deployed pod can fall back to env at runtime — but DO NOT
                // mark it as required (secret values come from env, not body).
                normalProps[key] = { ...prop, envName }
              } else {
                normalProps[key] = prop
                if (tool.parameters!.required?.includes(key)) {
                  normalRequired.push(key)
                }
              }
            }
            cleanedParameters = {
              ...tool.parameters,
              properties: normalProps,
              required: normalRequired.length > 0 ? normalRequired : undefined,
            }
          }

          // Extract non-secret params from testParams as presets
          const presetParams: Record<string, string> = {}
          if (tool.testParams) {
            for (const [key, val] of Object.entries(tool.testParams)) {
              if (val && !tool.parameters?.properties?.[key]?.secret) {
                presetParams[key] = String(val)
              }
            }
          }

          // Merge system connection env vars
          const allEnvVars = [...secretEnvVars, ...(tool.connectionEnvVars ?? [])]

          // API doc: prefer AI-generated, fallback to auto-generated from parameters
          const apiDoc = tool.apiDoc || generateApiDoc(cleanedParameters, tool.testParams, t)

          const newSkill: SkillPackage = {
            id: `ai-tool-${Date.now()}`,
            name: tool.title,
            description: tool.description,
            version: getCurrentVersion(),
            size: `${(new Blob([tool.code]).size / 1024).toFixed(1)} KB`,
            uploadedAt: new Date().toISOString().slice(0, 10),
            source: 'installed',
            category: t('skills.generatorCategoryAI'),
            parameters: cleanedParameters,
            presetParams: Object.keys(presetParams).length > 0 ? presetParams : undefined,
            code: tool.code,
            language: tool.language ?? 'javascript',
            envVars: allEnvVars.length > 0 ? allEnvVars : undefined,
            apiDoc: apiDoc || undefined,
            connectorType: tool.connectorType,
            // Carry over the LLM's mode decision so the skill is created in
            // mount mode directly — no manual SQL UPDATE needed afterwards.
            needsFileMount: tool.needsFileMount === true,
          }
          const res = await fetch('/api/employee/skills', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ skill: newSkill }),
          })
          if (!res.ok) {
            showToast('info', t('skills.saveFailed'))
            return
          }
          setInstalledSkills((prev) => [newSkill, ...prev])
          setActiveTab('installed')
          showToast('success', t('skills.aiToolCreated', { name: tool.title }))
        }}
      />

      {/* API tool editor dialog */}
      <ApiToolEditor
        open={apiEditorOpen}
        onOpenChange={(open) => {
          setApiEditorOpen(open)
          if (!open) setApiEditorTool(undefined)
        }}
        tool={apiEditorTool}
        onSaved={(saved) => {
          // Update or prepend the saved skill in the list
          setInstalledSkills((prev) => {
            const idx = prev.findIndex((s) => s.id === saved.id)
            if (idx >= 0) {
              const next = [...prev]
              next[idx] = saved
              return next
            }
            return [saved, ...prev]
          })
          showToast('success', t('skills.updated', { name: saved.name }))
        }}
      />

      {/* Tool editor dialog */}
      {editingSkill && (
        <ToolEditor
          skill={editingSkill}
          onClose={() => setEditingSkill(null)}
          onSave={async (updated) => {
            const res = await fetch('/api/employee/skills', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ skill: updated }),
            })
            if (!res.ok) {
              showToast('info', t('skills.saveFailed'))
              return
            }
            setInstalledSkills((prev) => prev.map((s) => (s.id === updated.id ? updated : s)))
            // Sync selectedTemplate to avoid stale data for new instances
            if (selectedTemplate?.id === updated.id) {
              setSelectedTemplate(updated)
            }
            setEditingSkill(null)
            showToast('success', t('skills.updated', { name: updated.name }))
          }}
        />
      )}

      {/* Instance preset editor dialog */}
      {editingInstance && selectedTemplate && (
        <ToolEditor
          instanceId={editingInstance.id}
          instanceDeploy={editingInstance.deploy}
          skill={{
            ...selectedTemplate,
            presetParams: editingInstance.presetParams ?? selectedTemplate.presetParams,
            envVars: editingInstance.envVars ?? selectedTemplate.envVars,
            connectionId: editingInstance.connectionId,
          }}
          availableConnections={preloadedConnections.map((c) => ({
            id: c.id,
            name: c.name,
            type: c.type,
            dbType: c.type === 'database' ? (c.config.dbType as string | undefined) : undefined,
            config: c.config,
          }))}
          onClose={() => setEditingInstance(null)}
          onSave={async (updated) => {
            const res = await fetch(`/api/employee/skills/instances/${editingInstance.id}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                presetParams: updated.presetParams,
                envVars: updated.envVars,
                connectionId: updated.connectionId ?? null,
              }),
            })
            if (!res.ok) {
              showToast('info', t('skills.saveFailed'))
              return
            }
            setInstances((prev) =>
              prev.map((i) =>
                i.id === editingInstance.id
                  ? {
                      ...i,
                      presetParams: updated.presetParams,
                      envVars: updated.envVars,
                      connectionId: updated.connectionId,
                      updatedAt: new Date().toISOString(),
                    }
                  : i
              )
            )
            setEditingInstance(null)
            showToast('success', t('skills.instancePresetUpdated', { name: editingInstance.name }))

            // Long-lived deployments snapshot env at deploy time, so an
            // env/connection edit only reaches the running container after a
            // redeploy. Script tools resolve env per-invocation → no prompt.
            const envChanged =
              JSON.stringify(editingInstance.envVars ?? []) !==
              JSON.stringify(updated.envVars ?? [])
            const connChanged =
              (editingInstance.connectionId ?? null) !== (updated.connectionId ?? null)
            const deployType = editingInstance.deploy?.deployType
            const isDeployed = editingInstance.deploy?.status === 'deployed'
            if (
              (envChanged || connChanged) &&
              isDeployed &&
              (deployType === 'opensandbox' || deployType === 'k8s')
            ) {
              setRedeployPrompt({
                ...editingInstance,
                envVars: updated.envVars,
                connectionId: updated.connectionId,
                presetParams: updated.presetParams,
              })
            }
          }}
        />
      )}

      {redeployPrompt && (
        <RedeployPrompt
          instanceName={redeployPrompt.name}
          redeploying={deployingIds.has(redeployPrompt.id)}
          onLater={() => setRedeployPrompt(null)}
          onRedeploy={async () => {
            const target = redeployPrompt
            setRedeployPrompt(null)
            await handleDeployInstance(target)
          }}
        />
      )}

      {/* Edit template meta (name + description) dialog */}
      {editingTemplateMeta && (
        <div
          className='fixed inset-0 z-40 flex items-center justify-center bg-black/30'
          onClick={() => {
            if (!metaSaving) setEditingTemplateMeta(null)
          }}
        >
          <div
            className='relative w-[480px] rounded-2xl bg-white p-6 shadow-2xl'
            onClick={(e) => e.stopPropagation()}
          >
            <div className='mb-4 flex items-center justify-between'>
              <div className='flex items-center gap-3'>
                <div className='flex h-10 w-10 items-center justify-center rounded-full bg-violet-100'>
                  <Pencil className='h-5 w-5 text-violet-600' />
                </div>
                <h2 className='font-semibold text-gray-900 text-lg'>{t('skills.editMetaTitle')}</h2>
              </div>
              <button
                type='button'
                onClick={() => {
                  if (!metaSaving) setEditingTemplateMeta(null)
                }}
                className='rounded-lg p-1.5 hover:bg-gray-100'
              >
                <X className='h-4 w-4 text-gray-400' />
              </button>
            </div>

            <div className='space-y-4'>
              <div>
                <label
                  htmlFor='template-meta-name'
                  className='mb-1.5 block font-medium text-gray-700 text-sm'
                >
                  {t('skills.aiGeneratorToolName')}
                </label>
                <input
                  id='template-meta-name'
                  type='text'
                  value={metaDraftName}
                  onChange={(e) => setMetaDraftName(e.target.value)}
                  className='w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-violet-400 focus:outline-none focus:ring-1 focus:ring-violet-300'
                  data-testid='dialog:edit-meta:input:name'
                />
              </div>
              <div>
                <label
                  htmlFor='template-meta-description'
                  className='mb-1.5 block font-medium text-gray-700 text-sm'
                >
                  {t('skills.aiGeneratorToolDesc')}
                </label>
                <textarea
                  id='template-meta-description'
                  value={metaDraftDescription}
                  onChange={(e) => setMetaDraftDescription(e.target.value)}
                  rows={3}
                  className='w-full resize-none rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-violet-400 focus:outline-none focus:ring-1 focus:ring-violet-300'
                  data-testid='dialog:edit-meta:input:description'
                />
              </div>
            </div>

            <div className='mt-6 flex justify-end gap-3'>
              <Button
                variant='outline'
                onClick={() => setEditingTemplateMeta(null)}
                disabled={metaSaving}
              >
                {t('common.cancel')}
              </Button>
              <Button
                onClick={handleSaveTemplateMeta}
                disabled={metaSaving || !metaDraftName.trim()}
                className='bg-violet-600 hover:bg-violet-700'
                data-testid='dialog:edit-meta:submit'
              >
                {metaSaving ? (
                  <>
                    <Loader2 className='mr-2 h-4 w-4 animate-spin' />
                    {t('common.save')}
                  </>
                ) : (
                  t('common.save')
                )}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Uninstall confirmation dialog */}
      {deleteTarget && (
        <div
          className='fixed inset-0 z-40 flex items-center justify-center bg-black/30'
          onClick={() => setDeleteTarget(null)}
        >
          <div
            className='relative w-[420px] rounded-2xl bg-white p-6 shadow-2xl'
            onClick={(e) => e.stopPropagation()}
          >
            <div className='mb-4 flex items-center gap-3'>
              <div className='flex h-10 w-10 items-center justify-center rounded-full bg-red-100'>
                <AlertTriangle className='h-5 w-5 text-red-600' />
              </div>
              <h2 className='font-semibold text-gray-900 text-lg'>
                {t('skills.confirmUninstallTitle')}
              </h2>
            </div>
            <p className='mb-6 text-gray-600 text-sm'>
              {t('skills.confirmUninstall', { name: deleteTarget.name })}
            </p>
            <div className='flex justify-end gap-3'>
              <Button
                variant='outline'
                onClick={() => setDeleteTarget(null)}
                disabled={deletingTemplate}
              >
                {t('common.cancel')}
              </Button>
              <Button variant='destructive' onClick={confirmDelete} disabled={deletingTemplate}>
                {deletingTemplate ? (
                  <>
                    <Loader2 className='mr-2 h-4 w-4 animate-spin' />
                    {t('skills.uninstalling')}
                  </>
                ) : (
                  t('skills.confirmUninstallBtn')
                )}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Delete instance confirmation dialog */}
      {deleteInstanceTarget && (
        <div
          className='fixed inset-0 z-40 flex items-center justify-center bg-black/30'
          onClick={() => setDeleteInstanceTarget(null)}
        >
          <div
            className='relative w-[420px] rounded-2xl bg-white p-6 shadow-2xl'
            onClick={(e) => e.stopPropagation()}
          >
            <div className='mb-4 flex items-center gap-3'>
              <div className='flex h-10 w-10 items-center justify-center rounded-full bg-red-100'>
                <AlertTriangle className='h-5 w-5 text-red-600' />
              </div>
              <h2 className='font-semibold text-gray-900 text-lg'>
                {t('skills.confirmDeleteInstanceTitle')}
              </h2>
            </div>
            <p className='mb-6 text-gray-600 text-sm'>
              {t('skills.confirmDeleteInstance', { name: deleteInstanceTarget.name })}
            </p>
            <div className='flex justify-end gap-3'>
              <Button
                variant='outline'
                onClick={() => setDeleteInstanceTarget(null)}
                disabled={deletingInstance}
              >
                {t('common.cancel')}
              </Button>
              <Button
                variant='destructive'
                onClick={confirmDeleteInstance}
                disabled={deletingInstance}
              >
                {deletingInstance ? (
                  <>
                    <Loader2 className='mr-2 h-4 w-4 animate-spin' />
                    {t('skills.deleting')}
                  </>
                ) : (
                  t('skills.confirmDeleteBtn')
                )}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* API Key config dialog */}
      {apiKeysDialogOpen && (
        <div
          className='fixed inset-0 z-40 flex items-center justify-center bg-black/30'
          onClick={() => setApiKeysDialogOpen(false)}
        >
          <div
            className='relative w-[540px] rounded-2xl bg-white p-6 shadow-2xl'
            onClick={(e) => e.stopPropagation()}
          >
            <div className='mb-4 flex items-center justify-between'>
              <div className='flex items-center gap-3'>
                <div className='flex h-10 w-10 items-center justify-center rounded-full bg-violet-100'>
                  <KeyRound className='h-5 w-5 text-violet-600' />
                </div>
                <div>
                  <h2 className='font-semibold text-gray-900 text-lg'>
                    {t('skills.apiKeyConfig')}
                  </h2>
                  <p className='text-gray-500 text-xs'>{t('skills.apiKeyConfigHint')}</p>
                </div>
              </div>
              <button
                type='button'
                onClick={() => setApiKeysDialogOpen(false)}
                className='rounded-lg p-1.5 hover:bg-gray-100'
              >
                <X className='h-4 w-4 text-gray-400' />
              </button>
            </div>

            <div className='max-h-[400px] space-y-3 overflow-y-auto'>
              {apiKeys.map((entry, idx) => (
                <div key={idx} className='flex items-center gap-2'>
                  <input
                    type='text'
                    value={entry.name}
                    onChange={(e) => {
                      const next = [...apiKeys]
                      next[idx] = { ...entry, name: e.target.value }
                      setApiKeys(next)
                    }}
                    placeholder={t('skills.apiKeyNamePlaceholder')}
                    className='flex-1 rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-violet-400 focus:outline-none focus:ring-1 focus:ring-violet-300'
                    data-testid={`dialog:api-keys:input:name:${idx}`}
                  />
                  <input
                    type='password'
                    value={entry.value}
                    onChange={(e) => {
                      const next = [...apiKeys]
                      next[idx] = { ...entry, value: e.target.value }
                      setApiKeys(next)
                    }}
                    placeholder={t('skills.apiKeyValuePlaceholder')}
                    className='flex-1 rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-violet-400 focus:outline-none focus:ring-1 focus:ring-violet-300'
                    data-testid={`dialog:api-keys:input:value:${idx}`}
                  />
                  <button
                    type='button'
                    onClick={() => setApiKeys(apiKeys.filter((_, i) => i !== idx))}
                    className='shrink-0 rounded-lg p-2 text-red-400 hover:bg-red-50 hover:text-red-600'
                    data-testid={`dialog:api-keys:button:remove:${idx}`}
                  >
                    <Trash2 className='h-4 w-4' />
                  </button>
                </div>
              ))}

              {apiKeys.length === 0 && (
                <p className='py-4 text-center text-gray-400 text-sm'>{t('skills.apiKeyEmpty')}</p>
              )}
            </div>

            <div className='mt-4 flex items-center justify-between'>
              <button
                type='button'
                onClick={() => setApiKeys([...apiKeys, { name: '', value: '' }])}
                className='flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm text-violet-600 hover:bg-violet-50'
                data-testid='dialog:api-keys:button:add'
              >
                <Plus className='h-4 w-4' />
                {t('skills.apiKeyAdd')}
              </button>
              <Button
                onClick={async () => {
                  const valid = apiKeys.filter(
                    (e) => String(e.name ?? '').trim() && String(e.value ?? '').trim()
                  )
                  setApiKeys(valid)
                  try {
                    const res = await fetch('/api/employee/tools/api-keys', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ keys: valid }),
                    })
                    if (!res.ok) throw new Error()
                    setApiKeysDialogOpen(false)
                    showToast('success', t('skills.apiKeySaved'))
                  } catch {
                    showToast('info', t('skills.apiKeySaveFailed'))
                  }
                }}
                className='bg-violet-600 hover:bg-violet-700'
                data-testid='dialog:api-keys:submit'
              >
                {t('skills.apiKeySaveConfig')}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* .cmapi import connection-mapping dialog */}
      {apiImportDialogOpen && apiImportPackage && (
        <div
          className='fixed inset-0 z-40 flex items-center justify-center bg-black/30'
          onClick={() => {
            if (!apiImporting) setApiImportDialogOpen(false)
          }}
        >
          <div
            className='relative w-[540px] rounded-2xl bg-white p-6 shadow-2xl'
            onClick={(e) => e.stopPropagation()}
            data-testid='api-tool-import:dialog'
          >
            {/* Header */}
            <div className='mb-4 flex items-center justify-between'>
              <div className='flex items-center gap-3'>
                <div className='flex h-10 w-10 items-center justify-center rounded-full bg-cyan-100'>
                  <Download className='h-5 w-5 text-cyan-600' />
                </div>
                <div>
                  <h2 className='font-semibold text-gray-900 text-lg'>导入 API 工具 - 连接映射</h2>
                  <p className='text-gray-500 text-xs'>{apiImportPackage.name}</p>
                </div>
              </div>
              <button
                type='button'
                onClick={() => {
                  if (!apiImporting) setApiImportDialogOpen(false)
                }}
                className='rounded-lg p-1.5 hover:bg-gray-100'
              >
                <X className='h-4 w-4 text-gray-400' />
              </button>
            </div>

            {/* Tool info */}
            {apiImportPackage.description && (
              <p className='mb-4 text-gray-600 text-sm leading-relaxed'>
                {apiImportPackage.description}
              </p>
            )}

            {/* Connection requirements */}
            <div className='mb-4'>
              <p className='mb-2 font-medium text-gray-700 text-sm'>连接映射</p>
              {!apiImportPackage.connectionRequirements ||
              apiImportPackage.connectionRequirements.length === 0 ? (
                <div className='rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 text-gray-500 text-sm'>
                  无需连接映射
                </div>
              ) : (
                <div className='space-y-3'>
                  {apiImportPackage.connectionRequirements.map((req) => (
                    <div
                      key={req.ref}
                      className='flex items-center gap-3 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3'
                      data-testid={`api-tool-import:row:${req.ref}`}
                    >
                      <div className='min-w-0 flex-1'>
                        <p className='font-medium text-gray-800 text-sm'>{req.name}</p>
                        <p className='text-gray-400 text-xs'>{req.ref}</p>
                      </div>
                      <select
                        value={apiImportMapping[req.ref] ?? ''}
                        onChange={(e) =>
                          setApiImportMapping((prev) => ({
                            ...prev,
                            [req.ref]: e.target.value,
                          }))
                        }
                        className='min-w-[180px] rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:border-cyan-400 focus:outline-none focus:ring-1 focus:ring-cyan-300'
                        data-testid={`api-tool-import:select:${req.ref}`}
                      >
                        <option value=''>— 请选择连接 —</option>
                        {apiImportConnections.map((conn) => (
                          <option key={conn.id} value={conn.id}>
                            {conn.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Footer */}
            <div className='flex justify-end gap-3'>
              <Button
                variant='outline'
                onClick={() => setApiImportDialogOpen(false)}
                disabled={apiImporting}
              >
                取消
              </Button>
              <Button
                onClick={handleConfirmApiImport}
                disabled={apiImporting}
                className='bg-cyan-600 hover:bg-cyan-700'
                data-testid='api-tool-import:confirm'
              >
                {apiImporting ? (
                  <>
                    <Loader2 className='mr-2 h-4 w-4 animate-spin' />
                    导入中...
                  </>
                ) : (
                  '确认导入'
                )}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Publish-as-API settings dialog (api-kind tools) */}
      {publishDialogTool && (
        <div
          className='fixed inset-0 z-40 flex items-center justify-center bg-black/30'
          onClick={() => {
            if (!publishDialogLoading) setPublishDialogTool(null)
          }}
        >
          <div
            className='relative w-[520px] rounded-2xl bg-white p-6 shadow-2xl'
            onClick={(e) => e.stopPropagation()}
          >
            {/* Dialog header */}
            <div className='mb-4 flex items-center justify-between'>
              <div className='flex items-center gap-3'>
                <div className='flex h-10 w-10 items-center justify-center rounded-full bg-cyan-100'>
                  <Globe className='h-5 w-5 text-cyan-600' />
                </div>
                <div>
                  <h2 className='font-semibold text-gray-900 text-lg'>发布设置</h2>
                  <p className='text-gray-500 text-xs'>{publishDialogTool.name}</p>
                </div>
              </div>
              <button
                type='button'
                onClick={() => setPublishDialogTool(null)}
                className='rounded-lg p-1.5 hover:bg-gray-100'
                data-testid='dialog:publish-api:close'
              >
                <X className='h-4 w-4 text-gray-400' />
              </button>
            </div>

            {/* Loading state while fetching/creating instance */}
            {publishDialogLoading && (
              <div className='flex items-center justify-center py-8'>
                <Loader2 className='h-6 w-6 animate-spin text-cyan-600' />
                <span className='ml-2 text-gray-500 text-sm'>正在准备...</span>
              </div>
            )}

            {/* Content — shown once instance is ready */}
            {!publishDialogLoading && publishDialogInstance && (
              <>
                {/* Publish toggle */}
                <div className='mb-4 flex items-center gap-3 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3'>
                  <Switch
                    checked={!!publishDialogInstance.publishedAsApi}
                    onCheckedChange={handlePublishDialogToggle}
                    data-testid={`dialog:publish-api:switch:${publishDialogInstance.id}`}
                  />
                  <div>
                    <p className='font-medium text-gray-800 text-sm'>{t('skills.publishApi')}</p>
                    <p className='text-gray-500 text-xs'>
                      启用后，外部系统可通过 API Key 调用此工具
                    </p>
                  </div>
                </div>

                {/* API key management — only when published */}
                {publishDialogInstance.publishedAsApi && (
                  <ApiKeyPanel
                    instanceId={publishDialogInstance.id}
                    parameters={
                      publishDialogTool.parameters as Parameters<typeof ApiKeyPanel>[0]['parameters']
                    }
                  />
                )}

                {/* Close button */}
                <div className='mt-6 flex justify-end'>
                  <Button variant='outline' onClick={() => setPublishDialogTool(null)}>
                    {t('common.close')}
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
