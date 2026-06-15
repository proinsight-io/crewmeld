'use client'

import { useEffect, useMemo, useState } from 'react'
import { Mail, MessageSquare, Plus, Send, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { useTranslation } from '@/hooks/use-translation'
import { useSopEditorStore } from '@/stores/sop/editor-store'
import type { SopExit, SopNode } from '@/types/sop'

interface SopNodeConfigPanelProps {
  nodeId: string
}

interface DigitalEmployeeOption {
  id: string
  name: string
}

interface ContactMethod {
  type: string
  value: string
}

interface HumanEmployeeListOption {
  id: string
  name: string
  title: string
  contactMethods: ContactMethod[]
}

interface BoundInstanceOption {
  instanceId: string
  instanceName: string
  skillName: string
  deployStatus: string
}

const CONTACT_TYPE_KEYS: Record<string, string> = {
  email: 'connectors.contactEmail',
  feishu: 'connectors.contactFeishu',
  wecom: 'connectors.contactWecom',
  dingtalk: 'connectors.contactDingtalk',
}

const CONTACT_TYPE_ICONS: Record<string, typeof Mail> = {
  email: Mail,
  feishu: Send,
  wecom: MessageSquare,
  dingtalk: MessageSquare,
}

export function SopNodeConfigPanel({ nodeId }: SopNodeConfigPanelProps) {
  const { t } = useTranslation()
  const nodes = useSopEditorStore((s) => s.nodes)
  const updateSopNode = useSopEditorStore((s) => s.updateSopNode)

  const node = nodes.find((n) => n.id === nodeId)

  // ALL hooks must be declared before any early return
  const [digitalEmployees, setDigitalEmployees] = useState<DigitalEmployeeOption[]>([])
  const [boundInstances, setBoundInstances] = useState<BoundInstanceOption[]>([])
  const [humanEmployeeList, setHumanEmployeeList] = useState<HumanEmployeeListOption[]>([])

  useEffect(() => {
    if (!node) return
    const sopNode = node.data.sopNode
    if (sopNode.type === 'digital_employee') {
      fetch('/api/employee/employees')
        .then((r) => r.json())
        .then((data) => {
          if (data.data) {
            setDigitalEmployees(
              data.data.map((e: DigitalEmployeeOption) => ({ id: e.id, name: e.name }))
            )
          }
        })
        .catch(() => {})
    }
    if (sopNode.type === 'human_employee') {
      fetch('/api/employee/human-employees?pageSize=100')
        .then((r) => r.json())
        .then((data) => {
          if (data.success) {
            setHumanEmployeeList(
              data.data.map((u: HumanEmployeeListOption) => ({
                id: u.id,
                name: u.name,
                title: u.title,
                contactMethods: u.contactMethods ?? [],
              }))
            )
          }
        })
        .catch(() => {})
    }
  }, [node?.data.sopNode.type])

  // After selecting digital employee, load bound deployed instances
  useEffect(() => {
    if (!node) return
    const sopNode = node.data.sopNode
    if (sopNode.type !== 'digital_employee' || !sopNode.executorId) {
      setBoundInstances([])
      return
    }
    fetch(`/api/employee/skills/bindings?employeeId=${sopNode.executorId}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.bindings) {
          const deployed = (
            data.bindings as Array<{
              instanceId: string
              instanceName: string
              skillName: string
              deployStatus: string
            }>
          )
            .filter((b) => b.deployStatus === 'deployed')
            .map((b) => ({
              instanceId: b.instanceId,
              instanceName: b.instanceName,
              skillName: b.skillName,
              deployStatus: b.deployStatus,
            }))
          setBoundInstances(deployed)
        }
      })
      .catch(() => {})
  }, [node?.data.sopNode.type, node?.data.sopNode.executorId])

  // Name mapping for selected instances
  const selectedInstanceNames = useMemo(() => {
    const map = new Map<string, string>()
    for (const s of boundInstances) {
      map.set(s.instanceId, `${s.instanceName}`)
    }
    return map
  }, [boundInstances])

  // Get contact methods of selected human employee
  const selectedHumanEmployee = useMemo(() => {
    if (!node) return null
    const sopNode = node.data.sopNode
    if (sopNode.type !== 'human_employee' || !sopNode.executorId) return null
    return humanEmployeeList.find((u) => u.id === sopNode.executorId) ?? null
  }, [node?.data.sopNode.type, node?.data.sopNode.executorId, humanEmployeeList])

  // Normalize notifyMethod to array (backward compatible with old string)
  const notifyMethods: string[] = useMemo(() => {
    if (!node?.data.sopNode.notifyMethod) return []
    const m = node.data.sopNode.notifyMethod
    return Array.isArray(m) ? m : [m]
  }, [node?.data.sopNode.notifyMethod])

  // After selecting human employee, auto-set default notify method (email preferred)
  useEffect(() => {
    if (!node || !selectedHumanEmployee || notifyMethods.length > 0) return
    const cms = selectedHumanEmployee.contactMethods
    if (cms.length === 0) return
    const defaultMethod = cms.find((cm) => cm.type === 'email') ? 'email' : cms[0].type
    updateSopNode(nodeId, { notifyMethod: [defaultMethod] })
  }, [selectedHumanEmployee, notifyMethods.length])

  // Early return AFTER all hooks
  if (!node) return null

  const sopNode = node.data.sopNode

  const handleChange = (updates: Partial<SopNode>) => {
    updateSopNode(nodeId, updates)
  }

  const selectedToolIds = sopNode.toolIds ?? []

  // Unselected instances (available for dropdown)
  const unselectedInstances = boundInstances.filter((s) => !selectedToolIds.includes(s.instanceId))

  const addTool = (toolId: string) => {
    if (!toolId || selectedToolIds.includes(toolId)) return
    handleChange({ toolIds: [...selectedToolIds, toolId] })
  }

  const removeTool = (toolId: string) => {
    handleChange({ toolIds: selectedToolIds.filter((id) => id !== toolId) })
  }

  return (
    <div
      className='space-y-4 rounded-lg border border-gray-200 bg-white p-4'
      data-testid='sop-editor:config-panel'
    >
      <h3 className='font-semibold text-gray-900 text-sm'>{t('sops.nodeConfigTitle')}</h3>

      <div>
        <Label htmlFor='node-name' className='mb-1.5 text-gray-500 text-xs'>
          {t('sops.nodeConfigName')}
        </Label>
        <Input
          id='node-name'
          value={sopNode.name}
          onChange={(e) => handleChange({ name: e.target.value })}
          data-testid='sop-editor:config-panel:input:name'
        />
      </div>

      <div>
        <Label htmlFor='node-description' className='mb-1.5 text-gray-500 text-xs'>
          {t('sops.nodeConfigDesc')}
        </Label>
        <Textarea
          id='node-description'
          value={sopNode.description ?? ''}
          onChange={(e) => handleChange({ description: e.target.value })}
          rows={2}
          data-testid='sop-editor:config-panel:input:description'
        />
      </div>

      {sopNode.type === 'digital_employee' && (
        <div>
          <Label className='mb-1.5 text-gray-500 text-xs'>
            {t('sops.nodeConfigAssignEmployee')}
          </Label>
          <Select
            value={sopNode.executorId ?? ''}
            onValueChange={(v) =>
              handleChange({ executorId: v || undefined, workflowId: undefined, toolIds: [] })
            }
          >
            <SelectTrigger data-testid='sop-editor:config-panel:input:executor-id'>
              <SelectValue placeholder={t('sops.nodeConfigSelectEmployee')} />
            </SelectTrigger>
            <SelectContent>
              {digitalEmployees.map((e) => (
                <SelectItem key={e.id} value={e.id}>
                  {e.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {sopNode.type === 'digital_employee' && sopNode.executorId && (
        <div>
          <Label className='mb-1.5 text-gray-500 text-xs'>
            {t('sops.nodeConfigRelatedTools')}
            {selectedToolIds.length > 0 && (
              <span className='ml-1 text-blue-500'>
                {t('sops.nodeConfigSelectedCount', { count: selectedToolIds.length })}
              </span>
            )}
          </Label>

          {/* Selected instance tags */}
          {selectedToolIds.length > 0 && (
            <div
              className='mt-1 mb-1.5 flex flex-wrap gap-1'
              data-testid='sop-editor:config-panel:selected-tools'
            >
              {selectedToolIds.map((toolId) => (
                <span
                  key={toolId}
                  className='inline-flex items-center gap-1 rounded-md bg-blue-50 px-2 py-0.5 text-blue-700 text-xs'
                >
                  {selectedInstanceNames.get(toolId) ?? toolId}
                  <button
                    type='button'
                    className='rounded-sm hover:bg-blue-100'
                    onClick={() => removeTool(toolId)}
                    data-testid={`sop-editor:config-panel:remove-tool:${toolId}`}
                  >
                    <X className='h-3 w-3' />
                  </button>
                </span>
              ))}
            </div>
          )}

          {/* Dropdown to add instance */}
          {unselectedInstances.length > 0 ? (
            <Select value='' onValueChange={(v) => addTool(v)}>
              <SelectTrigger data-testid='sop-editor:config-panel:select:tool'>
                <SelectValue placeholder={t('sops.nodeConfigSelectToolInstance')} />
              </SelectTrigger>
              <SelectContent>
                {unselectedInstances.map((s) => (
                  <SelectItem key={s.instanceId} value={s.instanceId}>
                    {s.instanceName}（{s.skillName}）
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : boundInstances.length === 0 ? (
            <p className='mt-1.5 text-gray-400 text-xs'>
              {t('sops.nodeConfigNoDeployedInstances')}
            </p>
          ) : (
            <p className='mt-1.5 text-gray-400 text-xs'>
              {t('sops.nodeConfigAllInstancesSelected')}
            </p>
          )}
        </div>
      )}

      {sopNode.type === 'human_employee' && (
        <>
          {/* Approver source: configured collaborator vs the requester's direct leader */}
          <div>
            <Label className='mb-1.5 text-gray-500 text-xs'>
              {t('sops.nodeConfigApproverSource')}
            </Label>
            <div className='mt-1 space-y-1.5' data-testid='sop-editor:config-panel:approver-source'>
              {(['assignee', 'requester_leader'] as const).map((src) => (
                <label
                  key={src}
                  className='flex cursor-pointer items-center gap-2 rounded-md border border-gray-100 px-2.5 py-1.5 text-xs transition-colors hover:bg-gray-50'
                >
                  <input
                    type='radio'
                    name={`approver-source-${sopNode.id}`}
                    className='h-3.5 w-3.5 border-gray-300 text-blue-600 focus:ring-blue-500'
                    checked={(sopNode.approverSource ?? 'assignee') === src}
                    onChange={() => handleChange({ approverSource: src })}
                    data-testid={`sop-editor:config-panel:approver-source:${src}`}
                  />
                  <span>
                    {t(
                      src === 'assignee'
                        ? 'sops.nodeConfigApproverAssignee'
                        : 'sops.nodeConfigApproverLeader'
                    )}
                  </span>
                </label>
              ))}
            </div>
          </div>

          {(sopNode.approverSource ?? 'assignee') === 'requester_leader' && (
            <div className='rounded-md bg-blue-50 px-3 py-2 text-[11px] text-blue-700'>
              {t('sops.nodeConfigApproverLeaderHint')}
            </div>
          )}

          <div>
            <Label className='mb-1.5 text-gray-500 text-xs'>
              {(sopNode.approverSource ?? 'assignee') === 'requester_leader'
                ? t('sops.nodeConfigFallbackApprover')
                : t('sops.nodeConfigAssignHuman')}
            </Label>
            <Select
              value={sopNode.executorId ?? ''}
              onValueChange={(v) => {
                // When switching employee, clear old notify methods, auto-select first contact of new person
                const newEmployee = humanEmployeeList.find((u) => u.id === v)
                const cms = newEmployee?.contactMethods ?? []
                const defaultMethod =
                  cms.length > 0
                    ? [cms.find((cm) => cm.type === 'email') ? 'email' : cms[0].type]
                    : []
                handleChange({ executorId: v || undefined, notifyMethod: defaultMethod })
              }}
            >
              <SelectTrigger data-testid='sop-editor:config-panel:input:executor-id'>
                <SelectValue placeholder={t('sops.nodeConfigSelectHuman')} />
              </SelectTrigger>
              <SelectContent>
                {humanEmployeeList.map((u) => (
                  <SelectItem key={u.id} value={u.id}>
                    {u.name}（{u.title}）
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </>
      )}

      {sopNode.type === 'human_employee' && selectedHumanEmployee && (
        <div>
          <Label className='mb-1.5 text-gray-500 text-xs'>
            {t('sops.nodeConfigNotifyMethod')}
            {notifyMethods.length > 1 && (
              <span className='ml-1 text-blue-500'>
                {t('sops.nodeConfigNotifySelected', { count: notifyMethods.length })}
              </span>
            )}
          </Label>
          {selectedHumanEmployee.contactMethods.length > 0 ? (
            <div className='mt-1 space-y-1.5' data-testid='sop-editor:config-panel:notify-methods'>
              {selectedHumanEmployee.contactMethods.map((cm) => {
                const Icon = CONTACT_TYPE_ICONS[cm.type] ?? Send
                const checked = notifyMethods.includes(cm.type)
                return (
                  <label
                    key={cm.type}
                    className='flex cursor-pointer items-center gap-2 rounded-md border border-gray-100 px-2.5 py-1.5 text-xs transition-colors hover:bg-gray-50'
                  >
                    <input
                      type='checkbox'
                      className='h-3.5 w-3.5 rounded border-gray-300 text-blue-600 focus:ring-blue-500'
                      checked={checked}
                      onChange={() => {
                        const next = checked
                          ? notifyMethods.filter((m) => m !== cm.type)
                          : [...notifyMethods, cm.type]
                        // Keep at least one notification method
                        if (next.length > 0) handleChange({ notifyMethod: next })
                      }}
                      data-testid={`sop-editor:config-panel:notify:${cm.type}`}
                    />
                    <Icon className='h-3.5 w-3.5 shrink-0 text-gray-400' />
                    <span>
                      {CONTACT_TYPE_KEYS[cm.type]
                        ? t(CONTACT_TYPE_KEYS[cm.type] as Parameters<typeof t>[0])
                        : cm.type}
                    </span>
                    <span className='text-gray-400'>{cm.value}</span>
                  </label>
                )
              })}
            </div>
          ) : (
            <p className='text-amber-600 text-xs'>{t('sops.nodeConfigNoContact')}</p>
          )}
        </div>
      )}

      {(sopNode.type === 'human_confirm' || sopNode.type === 'human_employee') && (
        <div>
          <Label htmlFor='node-timeout' className='mb-1.5 text-gray-500 text-xs'>
            {t('sops.nodeConfigTimeout')}
          </Label>
          <Input
            id='node-timeout'
            type='number'
            min={1}
            value={sopNode.timeoutMinutes ?? 60}
            onChange={(e) =>
              handleChange({ timeoutMinutes: Math.max(1, Number(e.target.value) || 60) })
            }
            data-testid='sop-editor:config-panel:input:timeout'
          />
        </div>
      )}

      {sopNode.type === 'human_confirm' && (
        <div>
          <h4 className='mb-2 font-medium text-gray-700 text-xs'>
            {t('sops.nodeConfigExitConfig')}
          </h4>
          <div className='space-y-1.5'>
            {sopNode.exits.map((exit) => (
              <div key={exit.id} className='flex items-center gap-2 text-gray-500 text-xs'>
                <span className='w-10 font-medium'>{exit.label}</span>
                <span className='text-gray-400'>→</span>
                <span>{exit.targetNodeId ?? t('sops.nodeConfigEndpoint')}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Multi-branch (Switch) configuration */}
      {sopNode.type === 'switch' &&
        (() => {
          const normalExits = (sopNode.exits ?? []).filter(
            (e) => e.type !== 'error' && e.condition?.type !== 'always'
          )
          const addCase = () => {
            const idx = normalExits.length + 1
            const newExit: SopExit = {
              id: `${sopNode.id}-exit-case-${idx}`,
              label: t('sops.nodeConfigBranchLabel', { idx }),
              targetNodeId: null,
              condition: { type: 'variable', operator: 'eq', value: '' },
            }
            handleChange({ exits: [...(sopNode.exits ?? []), newExit] })
          }
          const removeCase = (exitId: string) => {
            handleChange({ exits: (sopNode.exits ?? []).filter((e) => e.id !== exitId) })
          }
          const updateCaseValue = (exitId: string, value: string) => {
            handleChange({
              exits: (sopNode.exits ?? []).map((e) =>
                e.id === exitId
                  ? {
                      ...e,
                      label: value || e.label,
                      condition: {
                        ...e.condition,
                        type: 'variable' as const,
                        operator: 'eq' as const,
                        value,
                      },
                    }
                  : e
              ),
            })
          }

          return (
            <div className='space-y-3'>
              <h4 className='font-medium text-gray-700 text-xs'>
                {t('sops.nodeConfigBranchConfig')}
              </h4>

              <div>
                <Label className='mb-1.5 text-gray-500 text-xs'>
                  {t('sops.nodeConfigBranchList')}
                </Label>
                <div className='mt-1 space-y-1.5'>
                  {normalExits.map((exit) => (
                    <div key={exit.id} className='flex items-center gap-1.5'>
                      <span className='h-2 w-2 shrink-0 rounded-full bg-orange-400' />
                      <Input
                        className='h-8 text-xs'
                        value={String(exit.condition?.value ?? '')}
                        onChange={(e) => updateCaseValue(exit.id, e.target.value)}
                        placeholder={t('sops.nodeConfigBranchDesc')}
                      />
                      {normalExits.length > 1 && (
                        <button
                          type='button'
                          className='shrink-0 rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-500'
                          onClick={() => removeCase(exit.id)}
                        >
                          <Trash2 className='h-3 w-3' />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
                {normalExits.length < 10 && (
                  <Button
                    type='button'
                    variant='ghost'
                    size='sm'
                    className='mt-1.5 h-7 gap-1 text-orange-600 text-xs hover:text-orange-700'
                    onClick={addCase}
                  >
                    <Plus className='h-3 w-3' />
                    {t('sops.nodeConfigAddBranch')}
                  </Button>
                )}
              </div>

              <div className='rounded-md bg-orange-50 px-3 py-2 text-[11px] text-orange-700'>
                {t('sops.nodeConfigBranchHint')}
                <br />
                {t('sops.nodeConfigDefaultBranchHint')}
              </div>
            </div>
          )
        })()}

      <div className='border-gray-100 border-t pt-3'>
        <div className='text-[11px] text-gray-400'>
          {t('sops.nodeConfigNodeType')}{' '}
          {{
            digital_employee: t('sops.nodeConfigTypeEmployee'),
            human_employee: t('sops.nodeConfigTypeHuman'),
            human_confirm: t('sops.nodeConfigTypeHumanConfirm'),
            switch: t('sops.nodeConfigTypeBranch'),
          }[sopNode.type] ?? sopNode.type}
        </div>
        <div className='text-[11px] text-gray-400'>ID: {sopNode.id}</div>
      </div>
    </div>
  )
}
