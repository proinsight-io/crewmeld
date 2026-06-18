'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertCircle, ArrowLeft, Loader2, Play, Save } from 'lucide-react'
import { useParams, useRouter } from 'next/navigation'
import { ReactFlowProvider } from 'reactflow'
import { SopCanvas } from '@/components/sop/editor/sop-canvas'
import { SopTriggerBar } from '@/components/sop/editor/sop-trigger-bar'
import { PermissionPanel } from '@/components/sop/permission/permission-panel'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { buildRuleEditorCatalog } from '@/lib/access-rules/rule-editor-catalog'
import { serializeSopToPayload } from '@/lib/sop/serialize'
import type { IdentityFieldDef, SopVisibilityRules } from '@/lib/sop/visibility-types'
import { useTranslation } from '@/hooks/use-translation'
import { useSopEditorStore } from '@/stores/sop/editor-store'
import { SopNodeConfigPanel } from './node-config-panel'

export default function SopEditPage() {
  const { t } = useTranslation()
  const { id } = useParams<{ id: string }>()
  const router = useRouter()

  const [isLoading, setIsLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [toast, setToast] = useState<{ type: 'error' | 'success'; message: string } | null>(null)
  const [visibilityRules, setVisibilityRules] = useState<SopVisibilityRules | null>(null)
  const [unifiedFields, setUnifiedFields] = useState<Array<{ key: string; label: string }>>([])

  /** Channel-agnostic identity-field catalog forwarded to the permission panel. */
  const catalog = useMemo<IdentityFieldDef[]>(
    () =>
      buildRuleEditorCatalog(unifiedFields, {
        roles: t('accessRules.field.roles'),
        employeeId: t('accessRules.field.employeeId'),
      }),
    [unifiedFields, t]
  )

  const showToast = useCallback((type: 'error' | 'success', message: string) => {
    setToast({ type, message })
    setTimeout(() => setToast(null), 5000)
  }, [])

  const sopId = useSopEditorStore((s) => s.sopId)
  const name = useSopEditorStore((s) => s.name)
  const description = useSopEditorStore((s) => s.description)
  const triggerType = useSopEditorStore((s) => s.triggerType)
  const triggerConfig = useSopEditorStore((s) => s.triggerConfig)
  const sopTimeoutMinutes = useSopEditorStore((s) => s.sopTimeoutMinutes)
  const maxRejectionCycles = useSopEditorStore((s) => s.maxRejectionCycles)
  const version = useSopEditorStore((s) => s.version)
  const nodes = useSopEditorStore((s) => s.nodes)
  const edges = useSopEditorStore((s) => s.edges)
  const selectedNodeId = useSopEditorStore((s) => s.selectedNodeId)
  const isDirty = useSopEditorStore((s) => s.isDirty)
  const isSaving = useSopEditorStore((s) => s.isSaving)
  const setName = useSopEditorStore((s) => s.setName)
  const setDescription = useSopEditorStore((s) => s.setDescription)
  const loadDefinition = useSopEditorStore((s) => s.loadDefinition)
  const reset = useSopEditorStore((s) => s.reset)
  const setIsSaving = useSopEditorStore((s) => s.setIsSaving)
  const markClean = useSopEditorStore((s) => s.markClean)
  const markDirty = useSopEditorStore((s) => s.markDirty)

  /** Update visibility rules and flag the editor dirty so Save enables. */
  const handleVisibilityChange = useCallback(
    (next: SopVisibilityRules | null) => {
      setVisibilityRules(next)
      markDirty()
    },
    [markDirty]
  )

  /** Load SOP on mount */
  useEffect(() => {
    let cancelled = false
    async function load() {
      setIsLoading(true)
      setLoadError(null)
      try {
        const res = await fetch(`/api/employee/sops/${id}`)
        if (!res.ok) throw new Error(t('sops.editLoadFailed'))
        const json = await res.json()
        if (cancelled) return
        const data = json.data
        loadDefinition({
          id: data.id,
          name: data.name,
          description: data.description,
          triggerType: data.triggerType,
          triggerConfig: data.triggerConfig ?? {},
          sopTimeoutMinutes: data.sopTimeoutMinutes,
          maxRejectionCycles: data.maxRejectionCycles,
          version: data.version,
          nodes: data.nodes ?? [],
          edges: data.edges ?? [],
        })
        const rawVis = data.visibilityRules
        const validVis =
          rawVis && typeof rawVis === 'object' && 'enabled' in rawVis
            ? (rawVis as SopVisibilityRules)
            : null
        setVisibilityRules(validVis)

        // Fetch the unified identity-field map for the channel-agnostic permission editor.
        const fieldRes = await fetch('/api/employee/channel-field-mappings')
        if (fieldRes.ok) {
          const fieldJson = (await fieldRes.json()) as {
            success?: boolean
            data?: { fields?: Array<{ key: string; label?: string }> }
          }
          if (!cancelled && fieldJson?.success && Array.isArray(fieldJson.data?.fields)) {
            setUnifiedFields(
              fieldJson.data.fields.map((f) => ({ key: f.key, label: f.label ?? f.key }))
            )
          }
        }
        // A missing/failed field map is non-fatal: the catalog degrades to
        // the built-in roles + employeeId pickers supplied by buildRuleEditorCatalog.
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : t('sops.editLoadError'))
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }
    load()
    return () => {
      cancelled = true
      reset()
    }
  }, [id, loadDefinition, reset, t, showToast])

  /** Save SOP */
  const handleSave = useCallback(async () => {
    setIsSaving(true)
    try {
      const payload = serializeSopToPayload(nodes, edges, {
        name,
        description,
        triggerType,
        triggerConfig,
        sopTimeoutMinutes,
        maxRejectionCycles,
      })

      const res = await fetch(`/api/employee/sops/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, visibilityRules }),
      })

      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || t('sops.editSaveFailed'))
      }

      markClean()
    } finally {
      setIsSaving(false)
    }
  }, [
    id,
    nodes,
    edges,
    name,
    description,
    triggerType,
    triggerConfig,
    sopTimeoutMinutes,
    maxRejectionCycles,
    visibilityRules,
    setIsSaving,
    markClean,
    t,
  ])

  /** Trigger execution */
  const handleExecute = useCallback(async () => {
    if (isDirty) {
      try {
        await handleSave()
      } catch {
        // handleSave already shows a toast; don't proceed to execute
        return
      }
    }
    try {
      const res = await fetch(`/api/employee/sops/${id}/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const json = await res.json()
      if (!res.ok) {
        // Validation failed - show detailed errors
        if (json.validationErrors && Array.isArray(json.validationErrors)) {
          const messages = json.validationErrors
            .map((e: { nodeName: string; message: string }) => `「${e.nodeName}」${e.message}`)
            .join('；')
          showToast('error', messages)
        } else {
          showToast('error', json.error || t('sops.editStartFailed'))
        }
        return
      }
      const execId = json.data?.executionId
      if (execId) {
        router.push(`/sops/${id}/executions/${execId}`)
      }
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : t('sops.editStartFailed'))
    }
  }, [id, isDirty, handleSave, router, showToast, t])

  if (isLoading) {
    return (
      <div className='flex h-[80vh] items-center justify-center'>
        <Loader2 className='h-8 w-8 animate-spin text-gray-400' />
      </div>
    )
  }

  if (loadError) {
    return (
      <div className='flex h-[80vh] flex-col items-center justify-center gap-4'>
        <p className='text-red-600'>{loadError}</p>
        <Button variant='outline' onClick={() => router.push('/sops')}>
          {t('sops.editBackToList')}
        </Button>
      </div>
    )
  }

  return (
    <div className='flex h-[calc(100vh-3rem)] flex-col gap-3'>
      {/* Header */}
      <div className='flex items-start justify-between gap-3'>
        <div className='flex flex-1 items-start gap-3'>
          <button
            onClick={() => router.push('/sops')}
            className='mt-2 text-gray-500 hover:text-gray-900'
            data-testid='sop-editor:back'
          >
            <ArrowLeft className='h-5 w-5' />
          </button>
          <div className='flex flex-1 flex-col gap-1.5'>
            <div className='flex items-center gap-3'>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className='w-64 font-semibold text-lg'
                placeholder={t('sops.editNamePlaceholder')}
                data-testid='sop-editor:input:name'
              />
              {isDirty && <span className='text-amber-600 text-xs'>{t('sops.editUnsaved')}</span>}
            </div>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className='max-w-xl text-sm'
              maxLength={200}
              placeholder={t('sops.newDescPlaceholder')}
              data-testid='sop-editor:input:description'
            />
          </div>
        </div>
        <div className='flex shrink-0 items-center gap-2'>
          <span className='text-gray-400 text-xs'>v{version}</span>
          <Button
            variant='outline'
            size='sm'
            onClick={handleSave}
            disabled={isSaving || !isDirty}
            data-testid='sop-editor:save'
          >
            {isSaving ? (
              <Loader2 className='mr-1.5 h-4 w-4 animate-spin' />
            ) : (
              <Save className='mr-1.5 h-4 w-4' />
            )}
            {t('sops.editSave')}
          </Button>
          <Button size='sm' onClick={handleExecute} data-testid='canvas:toolbar:run'>
            <Play className='mr-1.5 h-4 w-4' />
            {t('sops.editExecute')}
          </Button>
        </div>
      </div>

      {/* Trigger Bar */}
      <SopTriggerBar />

      {/* Canvas + Config Panel */}
      <div className='flex min-h-0 flex-1 gap-3'>
        <div className='flex-1 overflow-hidden rounded-lg border border-gray-200 bg-white'>
          <ReactFlowProvider>
            <SopCanvas />
          </ReactFlowProvider>
        </div>

        {selectedNodeId ? (
          <div className='w-72 shrink-0'>
            <SopNodeConfigPanel nodeId={selectedNodeId} />
          </div>
        ) : (
          <div className='w-80 shrink-0 overflow-y-auto'>
            <PermissionPanel
              rules={visibilityRules}
              onChange={handleVisibilityChange}
              catalog={catalog}
            />
          </div>
        )}
      </div>

      {/* Toast notification */}
      {toast && (
        <div
          className={`-translate-x-1/2 fixed top-16 left-1/2 z-50 flex max-w-lg items-start gap-3 rounded-xl border px-5 py-3 shadow-lg ${
            toast.type === 'error'
              ? 'border-red-200 bg-red-50 text-red-800'
              : 'border-green-200 bg-green-50 text-green-800'
          }`}
        >
          <AlertCircle className='mt-0.5 h-4 w-4 shrink-0' />
          <span className='font-medium text-sm'>{toast.message}</span>
        </div>
      )}
    </div>
  )
}
