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
  Plus,
  Power,
  Rocket,
  Settings2,
  Sparkles,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { copyToClipboard } from '@/lib/core/utils/clipboard'
import { cn } from '@/lib/core/utils/cn'
import { useTranslation } from '@/hooks/use-translation'
import { PermissionGuard } from '../components/permission-guard'
// import { loadOfficialTools } from './load-official-skills'
import { AiToolGenerator } from './components/ai-tool-generator'
import { ToolEditor } from './components/skill-editor'
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
  onRename,
  onExport,
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
  onRename?: (newName: string) => void
  onExport?: () => void
}) {
  const { t } = useTranslation()
  const needsUpgrade =
    latestVersion !== undefined && compareVersions(latestVersion, skill.version) > 0
  const [editing, setEditing] = useState(false)
  const [editName, setEditName] = useState(skill.name)
  const nameInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) {
      nameInputRef.current?.focus()
      nameInputRef.current?.select()
    }
  }, [editing])

  const handleRenameConfirm = () => {
    const trimmed = editName.trim()
    if (trimmed && trimmed !== skill.name && onRename) {
      onRename(trimmed)
    }
    setEditing(false)
  }

  return (
    <div
      className={cn(
        'flex flex-col rounded-xl border border-gray-200 bg-white p-5 shadow-sm transition hover:shadow-md',
        onClick && 'cursor-pointer'
      )}
      onClick={() => {
        if (!editing) onClick?.()
      }}
      data-testid={`skills:template-card:${skill.id}`}
    >
      <div className='mb-3 flex items-start justify-between gap-2'>
        <div className='flex items-center gap-3'>
          <div className='flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-blue-50'>
            <Package className='h-5 w-5 text-blue-600' />
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
                    setEditName(skill.name)
                    setEditing(false)
                  }
                }}
                onClick={(e) => e.stopPropagation()}
                className='w-full border-violet-400 border-b bg-transparent px-0 py-0 font-semibold text-gray-900 text-sm outline-none'
                data-testid={`skills:input:rename:${skill.id}`}
              />
            ) : (
              <p
                className={cn(
                  'font-semibold text-gray-900 text-sm',
                  onRename && 'cursor-pointer hover:text-violet-600'
                )}
                onClick={(e) => {
                  if (onRename) {
                    e.stopPropagation()
                    setEditName(skill.name)
                    setEditing(true)
                  }
                }}
                title={onRename ? t('skills.clickToRename') : undefined}
              >
                {skill.name}
              </p>
            )}
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
        <div className='flex items-center gap-1' onClick={(e) => e.stopPropagation()}>
          {installed && !needsUpgrade && !onUninstall && (
            <span className='flex items-center gap-1 rounded-md px-2 py-1 text-green-600'>
              <CheckCheck className='h-3.5 w-3.5' />
              {t('skills.installed')}
            </span>
          )}
          {needsUpgrade && onUpgrade && (
            <button
              type='button'
              onClick={onUpgrade}
              className='flex items-center gap-1 rounded-md px-2 py-1 text-amber-600 hover:bg-amber-50'
            >
              <ArrowUpCircle className='h-3.5 w-3.5' />
              {t('skills.upgrade')}
            </button>
          )}
          {onInstall && (
            <button
              type='button'
              onClick={onInstall}
              className='flex items-center gap-1 rounded-md px-2 py-1 text-blue-600 hover:bg-blue-50'
            >
              <Download className='h-3.5 w-3.5' />
              {t('skills.install')}
            </button>
          )}
          {onExport && (
            <button
              type='button'
              onClick={onExport}
              className='flex items-center gap-1 rounded-md px-2 py-1 text-gray-500 hover:bg-gray-50'
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
              className='flex items-center gap-1 rounded-md px-2 py-1 text-red-500 hover:bg-red-50'
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
function InstanceCard({
  instance,
  template,
  onDeploy,
  onUndeploy,
  onEdit,
  onRename,
  onDelete,
  deploying,
  undeploying,
}: {
  instance: ToolInstance
  template: SkillPackage
  onDeploy?: () => void
  onUndeploy?: () => void
  onEdit?: () => void
  onRename?: (newName: string) => void
  onDelete?: () => void
  deploying?: boolean
  undeploying?: boolean
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
              <p
                className='cursor-pointer font-semibold text-gray-900 text-sm hover:text-violet-600'
                onClick={() => {
                  setEditName(instance.name)
                  setEditing(true)
                }}
                title={t('skills.clickToRename')}
              >
                {instance.name}
              </p>
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
                const params = template.parameters?.properties
                  ? Object.fromEntries(
                      Object.entries(template.parameters.properties).map(([k, v]) => [
                        k,
                        instance.presetParams?.[k] ??
                          template.presetParams?.[k] ??
                          (v.type === 'number'
                            ? 0
                            : v.type === 'boolean'
                              ? true
                              : v.description || k),
                      ])
                    )
                  : {}
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

      <div className='mt-auto flex items-center justify-end gap-1 text-xs'>
        {/* Deploy button */}
        {onDeploy && deployStatus !== 'deployed' && (
          <PermissionGuard requires='skill:deploy'>
            <button
              type='button'
              onClick={onDeploy}
              disabled={deploying}
              className={cn(
                'flex items-center gap-1 rounded-md px-2 py-1',
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
                'flex items-center gap-1 rounded-md px-2 py-1',
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
            className='flex items-center gap-1 rounded-md px-2 py-1 text-violet-600 hover:bg-violet-50'
            data-testid={`skills:button:edit-instance:${instance.id}`}
          >
            <Settings2 className='h-3.5 w-3.5' />
            {t('skills.editTool')}
          </button>
        )}
        {/* Delete button */}
        {onDelete && (
          <PermissionGuard requires='skill:delete'>
            <button
              type='button'
              onClick={onDelete}
              className='flex items-center gap-1 rounded-md px-2 py-1 text-red-500 hover:bg-red-50'
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
  const [importProjectContext, setImportProjectContext] = useState<GitHubProjectContext | null>(
    null
  )
  const [editingSkill, setEditingSkill] = useState<SkillPackage | null>(null)
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
    if (!skill.code) return // Without code, instances not supported
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
    return {
      onUninstall: () => setDeleteTarget({ id: installed.id, name: installed.name }),
      onClick: installed.code ? () => handleTemplateClick(installed) : undefined,
      onRename: (newName: string) => handleRename(installed, newName),
    }
  }

  const handleRename = async (skill: SkillPackage, newName: string) => {
    const updated = { ...skill, name: newName }
    const res = await fetch('/api/employee/skills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skill: updated }),
    })
    if (!res.ok) {
      showToast('info', t('skills.renameFailed'))
      return
    }
    setInstalledSkills((prev) => prev.map((s) => (s.id === skill.id ? updated : s)))
    showToast('success', t('skills.renamedTo', { name: newName }))
  }

  // handleUpgrade depends on official tools, not needed after hiding
  // const handleUpgrade = async (official: SkillPackage) => { ... }

  // Export template as zip
  const handleExportTemplate = async (skill: SkillPackage) => {
    const zip = new JSZip()

    // manifest.json - template metadata (no deploy/runtime state)
    // _crewmeld_export flag: directly restore on import, skip AI generation
    const manifest = {
      _crewmeld_export: true,
      id: skill.id,
      name: skill.name,
      description: skill.description,
      version: skill.version,
      source: skill.source,
      category: skill.category,
      author: skill.author,
      language: skill.language ?? 'javascript',
      parameters: skill.parameters,
      presetParams: skill.presetParams,
      envVars: skill.envVars?.map((e) => ({ name: e.name, value: '' })),
      apiDoc: skill.apiDoc,
      connectorType: skill.connectorType,
    }
    zip.file('manifest.json', JSON.stringify(manifest, null, 2))

    // Code file
    if (skill.code) {
      const ext = (skill.language ?? 'javascript') === 'python' ? 'py' : 'js'
      zip.file(`tool.${ext}`, skill.code)
    }

    const blob = await zip.generateAsync({ type: 'blob' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${skill.name}.zip`
    a.click()
    URL.revokeObjectURL(url)
    showToast('success', t('skills.exported'))
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

  // Unified import entry: route by file extension
  const importInputRef = useRef<HTMLInputElement>(null)
  const handleImportFile = (file: File) => {
    const ext = file.name.split('.').pop()?.toLowerCase()
    if (ext === 'zip') {
      handleImportTemplate(file)
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
                accept='.zip,.md,.txt'
                className='hidden'
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  if (file) handleImportFile(file)
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
                  onClick={() => setAiGeneratorOpen(true)}
                  className='bg-violet-600 hover:bg-violet-700'
                  data-testid='skills:button:ai-generate'
                >
                  <Sparkles className='mr-2 h-4 w-4' />
                  {t('skills.createTool')}
                </Button>
              </PermissionGuard>
            </>
          )}
        </div>
      </div>

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
                  onEdit={() => setEditingInstance(inst)}
                  onRename={(name) => handleRenameInstance(inst, name)}
                  onDelete={() => setDeleteInstanceTarget({ id: inst.id, name: inst.name })}
                  deploying={deployingIds.has(inst.id)}
                  undeploying={undeployingIds.has(inst.id)}
                />
              ))}
            </div>
          )}
        </div>
      ) : (
        <>
          {/* Tabs */}
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

          {/* Upgrade reminder banner（Not needed after hiding official tools）*/}

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
          }}
        />
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
    </div>
  )
}
