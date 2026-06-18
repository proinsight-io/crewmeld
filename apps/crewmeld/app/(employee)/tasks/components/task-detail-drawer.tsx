'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { SopExecutionStatus } from '@crewmeld/db/schema'
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Circle,
  Clock,
  Copy,
  FileText,
  Hourglass,
  Loader2,
  RotateCw,
  SkipForward,
  ThumbsDown,
  ThumbsUp,
  Wrench,
  X,
  XCircle,
  Zap,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { copyToClipboard } from '@/lib/core/utils/clipboard'
import type { SupportedLocale } from '@/lib/core/utils/formatting'
import {
  formatCompactDateTimeI18n,
  formatDurationFromRange,
  formatTimeOnlyI18n,
} from '@/lib/core/utils/formatting'
import { translateLogPayload } from '@/lib/i18n/log-payload'
import { useTranslation } from '@/hooks/use-translation'
import { useTaskDetail } from '../hooks/use-task-detail'
import type { ApprovalInfo, NodeLogEntry, SopNodeExecutionEntry } from '../types'

const NODE_STATUS_ICON: Record<string, React.ReactNode> = {
  pending: <Circle className='h-4 w-4 text-gray-400' />,
  running: <Loader2 className='h-4 w-4 animate-spin text-blue-500' />,
  completed: <CheckCircle2 className='h-4 w-4 text-green-500' />,
  skipped: <SkipForward className='h-4 w-4 text-gray-400' />,
  error: <XCircle className='h-4 w-4 text-red-500' />,
}

interface TaskDetailDrawerProps {
  executionId: string
  onClose: () => void
}

export function TaskDetailDrawer({ executionId, onClose }: TaskDetailDrawerProps) {
  const { t, locale } = useTranslation()
  const { data, isLoading, error, refetch } = useTaskDetail(executionId)
  const [allLogsOpen, setAllLogsOpen] = useState(false)
  const [allTimeline, setAllTimeline] = useState<Array<{
    timestamp: string
    type: string
    content: string
    data?: Record<string, unknown>
  }> | null>(null)
  const [allLogsLoading, setAllLogsLoading] = useState(false)
  const [approvals, setApprovals] = useState<ApprovalInfo[]>([])

  const STATUS_CONFIG = useMemo<
    Record<
      SopExecutionStatus,
      { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }
    >
  >(
    () => ({
      pending: { label: t('tasks.statusPending'), variant: 'secondary' },
      running: { label: t('tasks.statusRunning'), variant: 'default' },
      paused_for_human: { label: t('tasks.statusHitlWaiting'), variant: 'secondary' },
      // Suspended waiting on an async tool — surface as "running" since the task
      // is still in progress from the operator's perspective.
      paused_for_tool: { label: t('tasks.statusRunning'), variant: 'default' },
      completed: { label: t('tasks.statusCompleted'), variant: 'outline' },
      timed_out: { label: t('tasks.statusTimeout'), variant: 'destructive' },
      error: { label: t('tasks.statusError'), variant: 'destructive' },
      failed: { label: t('tasks.statusFailed'), variant: 'destructive' },
      cancelled: { label: t('tasks.statusCancelled'), variant: 'secondary' },
    }),
    [t]
  )

  const NODE_TYPE_LABELS = useMemo<Record<string, string>>(
    () => ({
      digital_employee: t('tasks.nodeTypeEmployee'),
      human_employee: t('tasks.nodeTypeHuman'),
      human_confirm: t('tasks.nodeTypeHumanConfirm'),
    }),
    [t]
  )

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  // Load all logs + approval status
  const loadAllLogs = useCallback(async () => {
    if (allTimeline) {
      setAllLogsOpen(!allLogsOpen)
      return
    }
    setAllLogsLoading(true)
    try {
      const resp = await fetch(`/api/employee/tasks/${executionId}/logs`)
      const json = await resp.json()
      if (json.success) {
        setAllTimeline(json.data.timeline ?? [])
        setApprovals(json.data.approvals ?? [])
      }
    } catch {
      // ignore
    } finally {
      setAllLogsLoading(false)
      setAllLogsOpen(true)
    }
  }, [executionId, allTimeline, allLogsOpen])

  // Fetch approval status on initial load
  useEffect(() => {
    if (!data) return
    const hasApprovalNode = data.nodeExecutions.some(
      (n) => n.nodeType === 'human_confirm' || n.nodeType === 'human_employee'
    )
    if (!hasApprovalNode) return
    fetch(`/api/employee/tasks/${executionId}/logs`)
      .then((r) => r.json())
      .then((json) => {
        if (json.success) {
          setApprovals(json.data.approvals ?? [])
        }
      })
      .catch(() => {})
  }, [data, executionId])

  return (
    <>
      <div className='fixed inset-0 z-40 bg-black/20' onClick={onClose} />
      <div className='fixed top-0 right-0 z-50 flex h-screen w-[520px] max-w-full flex-col bg-white shadow-xl'>
        <div className='flex items-center justify-between border-gray-200 border-b px-6 py-4'>
          <div className='flex items-center gap-3'>
            <h2 className='font-semibold text-gray-900 text-lg'>{t('tasks.detailTitle')}</h2>
            {data && (
              <Badge variant={STATUS_CONFIG[data.status]?.variant ?? 'secondary'}>
                {STATUS_CONFIG[data.status]?.label ?? data.status}
              </Badge>
            )}
          </div>
          <Button variant='ghost' size='icon' onClick={onClose}>
            <X className='h-5 w-5' />
          </Button>
        </div>

        <div className='flex-1 overflow-y-auto px-6 py-4'>
          {isLoading && (
            <div className='space-y-4'>
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className='h-16 animate-pulse rounded-lg bg-gray-100' />
              ))}
            </div>
          )}

          {error && (
            <div className='flex flex-col items-center justify-center py-12'>
              <AlertTriangle className='h-8 w-8 text-red-400' />
              <p className='mt-2 text-red-600 text-sm'>{t('tasks.detailLoadFailed')}</p>
              <Button variant='outline' size='sm' className='mt-3' onClick={refetch}>
                {t('common.retry')}
              </Button>
            </div>
          )}

          {data && (
            <div className='space-y-6'>
              <section className='space-y-3'>
                <h3 className='font-medium text-gray-500 text-sm'>{t('tasks.detailBasicInfo')}</h3>
                <div className='grid grid-cols-2 gap-3'>
                  <InfoItem
                    label={t('tasks.detailSopName')}
                    value={`${data.sopName} v${data.sopVersion}`}
                  />
                  <InfoItem label={t('tasks.detailTrigger')} value={data.triggeredByName} />
                  <InfoItem
                    label={t('tasks.detailCreatedAt')}
                    value={formatCompactDateTimeI18n(data.createdAt, locale as SupportedLocale)}
                  />
                  <InfoItem
                    label={t('tasks.detailStartedAt')}
                    value={
                      data.startedAt
                        ? formatCompactDateTimeI18n(data.startedAt, locale as SupportedLocale)
                        : '—'
                    }
                  />
                  <InfoItem
                    label={t('tasks.detailCompletedAt')}
                    value={
                      data.completedAt
                        ? formatCompactDateTimeI18n(data.completedAt, locale as SupportedLocale)
                        : '—'
                    }
                  />
                  <InfoItem
                    label={t('tasks.detailDuration')}
                    value={formatDurationFromRange(data.startedAt, data.completedAt)}
                    icon={<Clock className='h-3.5 w-3.5' />}
                  />
                  <InfoItem
                    label={t('tasks.detailNodeProgress')}
                    value={`${data.completedNodes}/${data.totalNodes}`}
                  />
                  {data.retryCount > 0 && (
                    <InfoItem
                      label={t('tasks.detailRetryCount')}
                      value={String(data.retryCount)}
                      icon={<RotateCw className='h-3.5 w-3.5' />}
                    />
                  )}
                </div>
              </section>

              {data.errorMessage && (
                <section className='rounded-lg border border-red-200 bg-red-50 p-3'>
                  <p className='font-medium text-red-600 text-xs'>
                    {t('tasks.detailErrorMessage')}
                  </p>
                  <p className='mt-1 text-red-800 text-sm'>
                    {translateLogPayload(
                      data.errorMessage,
                      typeof data.metadata?.errorI18nKey === 'string'
                        ? {
                            i18nKey: data.metadata.errorI18nKey,
                            i18nParams: data.metadata.errorI18nParams as
                              | Record<string, string | number>
                              | undefined,
                          }
                        : null,
                      t,
                      'errSop'
                    )}
                  </p>
                </section>
              )}

              <section>
                <div className='mb-3 flex items-center justify-between'>
                  <h3 className='font-medium text-gray-500 text-sm'>
                    {t('tasks.detailNodeTimeline')} ({data.nodeExecutions.length})
                  </h3>
                  <Button
                    variant='ghost'
                    size='sm'
                    className='h-7 gap-1 text-blue-600 text-xs hover:text-blue-700'
                    onClick={loadAllLogs}
                    disabled={allLogsLoading}
                    data-testid='sop-detail:btn:view-all-logs'
                  >
                    {allLogsLoading ? (
                      <Loader2 className='h-3 w-3 animate-spin' />
                    ) : (
                      <FileText className='h-3 w-3' />
                    )}
                    {t('tasks.detailViewAllLogs')}
                  </Button>
                </div>

                {data.nodeExecutions.length === 0 ? (
                  <p className='py-4 text-center text-gray-400 text-sm'>
                    {t('tasks.detailNoNodeRecords')}
                  </p>
                ) : (
                  <div className='space-y-0'>
                    {data.nodeExecutions.map((node, idx) => (
                      <NodeExecutionItem
                        key={node.id}
                        node={node}
                        isLast={idx === data.nodeExecutions.length - 1}
                        nodeTypeLabels={NODE_TYPE_LABELS}
                        locale={locale as SupportedLocale}
                        executionId={executionId}
                        approval={approvals.find((a) => a.nodeId === node.nodeId)}
                        t={t}
                      />
                    ))}
                  </div>
                )}
              </section>
            </div>
          )}
        </div>
      </div>

      {/* All logs modal */}
      {allLogsOpen && allTimeline && (
        <AllLogsModal timeline={allTimeline} t={t} onClose={() => setAllLogsOpen(false)} />
      )}
    </>
  )
}

interface TimelineEntry {
  timestamp: string
  type: string
  content: string
  data?: Record<string, unknown>
}

/** All logs modal - raw JSON format */
function AllLogsModal({
  timeline,
  t,
  onClose,
}: {
  timeline: TimelineEntry[]
  t: (key: Parameters<ReturnType<typeof useTranslation>['t']>[0]) => string
  onClose: () => void
}) {
  const [copied, setCopied] = useState(false)
  const jsonText = useMemo(() => JSON.stringify(timeline, null, 2), [timeline])

  const handleCopy = useCallback(async () => {
    await copyToClipboard(jsonText)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }, [jsonText])

  // Close on ESC
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  return (
    <div className='fixed inset-0 z-[60] flex items-center justify-center'>
      <div className='absolute inset-0 bg-black/40' onClick={onClose} />
      <div className='relative flex max-h-[85vh] w-[90vw] max-w-[900px] flex-col rounded-xl bg-white shadow-2xl'>
        <div className='flex items-center justify-between border-gray-200 border-b px-5 py-3'>
          <h3 className='font-semibold text-gray-900 text-sm'>{t('tasks.detailAllLogsTitle')}</h3>
          <div className='flex items-center gap-2'>
            <button
              type='button'
              className={`flex items-center gap-1 rounded-md px-2.5 py-1 text-xs transition-colors ${
                copied ? 'text-green-600' : 'text-gray-500 hover:bg-gray-100 hover:text-gray-700'
              }`}
              onClick={handleCopy}
            >
              {copied ? <CheckCircle2 className='h-3.5 w-3.5' /> : <Copy className='h-3.5 w-3.5' />}
              {copied ? t('tasks.detailCopied') : t('tasks.detailCopy')}
            </button>
            <button
              type='button'
              className='rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600'
              onClick={onClose}
            >
              <X className='h-4 w-4' />
            </button>
          </div>
        </div>
        <div className='flex-1 overflow-auto bg-[#1e1e1e] p-4'>
          {timeline.length === 0 ? (
            <p className='py-8 text-center text-gray-500 text-sm'>{t('tasks.detailNoLogs')}</p>
          ) : (
            <div className='font-mono text-xs leading-[1.6]'>
              <JsonNode value={timeline} />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/** Single log entry row */
function LogEntryRow({
  log,
  t,
}: {
  log: NodeLogEntry
  t: (key: Parameters<ReturnType<typeof useTranslation>['t']>[0]) => string
}) {
  const meta = log.metadata ?? {}
  const isToolCall = log.logType === 'tool_call'
  const isError = log.logType === 'error'
  const [expanded, setExpanded] = useState(false)

  // Replace tool ID in content with friendly name (backward compatible)
  const displayContent = useMemo(() => {
    if (!isToolCall) return log.content
    const name = typeof meta.instanceName === 'string' ? meta.instanceName : null
    if (!name) return log.content
    // Replace skill_inst-xxx or inst-xxx in content with instance name
    return log.content.replace(/skill_inst-[\w-]+|inst-[\w-]+/g, name)
  }, [log.content, isToolCall, meta.instanceName])

  const logTypeConfig: Record<string, { icon: React.ReactNode; label: string; color: string }> = {
    action: {
      icon: <Zap className='h-3 w-3' />,
      label: t('tasks.detailLogAction'),
      color: 'text-blue-600',
    },
    tool_call: {
      icon: <Wrench className='h-3 w-3' />,
      label: t('tasks.detailLogToolCall'),
      color: 'text-purple-600',
    },
    error: {
      icon: <AlertCircle className='h-3 w-3' />,
      label: t('tasks.detailLogError'),
      color: 'text-red-600',
    },
  }

  const config = logTypeConfig[log.logType] ?? logTypeConfig.action

  return (
    <div
      className={`rounded-md border px-2.5 py-1.5 text-xs ${isError ? 'border-red-200 bg-red-50' : 'border-gray-150 bg-white'}`}
    >
      <div className='flex items-start gap-2'>
        <span className={`mt-0.5 shrink-0 ${config.color}`}>{config.icon}</span>
        <span className={`shrink-0 font-medium ${config.color}`}>{config.label}</span>
        <span className='min-w-0 flex-1 break-words text-gray-600'>{displayContent}</span>
        <span className='shrink-0 text-[10px] text-gray-400'>
          {new Date(log.createdAt).toLocaleTimeString()}
        </span>
        {isToolCall && (
          <button
            type='button'
            className='mt-0.5 shrink-0 text-gray-400 hover:text-gray-600'
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? <ChevronUp className='h-3 w-3' /> : <ChevronDown className='h-3 w-3' />}
          </button>
        )}
      </div>
      {isToolCall && expanded && <ToolCallDetail meta={meta} t={t} />}
    </div>
  )
}

/** Tool call detail expansion */
function ToolCallDetail({
  meta,
  t,
}: {
  meta: Record<string, unknown>
  t: (key: Parameters<ReturnType<typeof useTranslation>['t']>[0]) => string
}) {
  const input = meta.input as Record<string, unknown> | undefined
  const output = meta.output as Record<string, unknown> | undefined
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(async () => {
    const toolName =
      typeof meta.instanceName === 'string'
        ? meta.instanceName
        : typeof meta.toolName === 'string'
          ? meta.toolName
          : t('tasks.unknownTool')
    const sections: string[] = [`${t('tasks.toolLabel')}: ${toolName}`]
    if (typeof meta.durationMs === 'number')
      sections.push(`${t('tasks.durationLabel')}: ${meta.durationMs}ms`)
    if (input) sections.push(`\n${t('tasks.inputLabel')}:\n${JSON.stringify(input, null, 2)}`)
    if (output) sections.push(`\n${t('tasks.outputLabel')}:\n${JSON.stringify(output, null, 2)}`)
    await copyToClipboard(sections.join('\n'))
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }, [meta, input, output])

  return (
    <div className='mt-1.5 space-y-1.5 border-gray-100 border-t pt-1.5'>
      <div className='flex items-center justify-between'>
        {(typeof meta.instanceName === 'string' || typeof meta.toolName === 'string') && (
          <div className='text-[10px] text-gray-500'>
            {typeof meta.instanceName === 'string' ? meta.instanceName : (meta.toolName as string)}
            {typeof meta.durationMs === 'number' && (
              <span className='ml-2'>
                {t('tasks.detailLogDuration')}: {meta.durationMs}ms
              </span>
            )}
          </div>
        )}
        <button
          type='button'
          className={`flex shrink-0 items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] transition-colors ${
            copied ? 'text-green-600' : 'text-gray-400 hover:bg-gray-100 hover:text-gray-600'
          }`}
          onClick={handleCopy}
        >
          {copied ? <CheckCircle2 className='h-2.5 w-2.5' /> : <Copy className='h-2.5 w-2.5' />}
          {copied ? t('tasks.detailCopied') : t('tasks.detailCopy')}
        </button>
      </div>
      {input && (
        <div>
          <span className='font-medium text-[10px] text-gray-500'>{t('tasks.detailLogInput')}</span>
          <pre className='mt-0.5 max-h-[120px] overflow-auto whitespace-pre-wrap break-all rounded bg-gray-50 p-1.5 font-mono text-[10px] text-gray-600'>
            {JSON.stringify(input, null, 2)}
          </pre>
        </div>
      )}
      {output && (
        <div>
          <span className='font-medium text-[10px] text-gray-500'>
            {t('tasks.detailLogOutput')}
          </span>
          <pre className='mt-0.5 max-h-[120px] overflow-auto whitespace-pre-wrap break-all rounded bg-gray-50 p-1.5 font-mono text-[10px] text-gray-600'>
            {JSON.stringify(output, null, 2)}
          </pre>
        </div>
      )}
    </div>
  )
}

/** Node timeline item */
function NodeExecutionItem({
  node,
  isLast,
  nodeTypeLabels,
  locale,
  executionId,
  approval,
  t,
}: {
  node: SopNodeExecutionEntry
  isLast: boolean
  nodeTypeLabels: Record<string, string>
  locale: SupportedLocale
  executionId: string
  approval?: ApprovalInfo
  t: (key: Parameters<ReturnType<typeof useTranslation>['t']>[0]) => string
}) {
  const icon = NODE_STATUS_ICON[node.status] ?? <Circle className='h-4 w-4 text-gray-400' />
  const typeLabel = nodeTypeLabels[node.nodeType] ?? node.nodeType
  const isApprovalNode = node.nodeType === 'human_confirm' || node.nodeType === 'human_employee'
  const isDigitalEmployee = node.nodeType === 'digital_employee'

  const [logsOpen, setLogsOpen] = useState(false)
  const [nodeLogs, setNodeLogs] = useState<NodeLogEntry[] | null>(null)
  const [logsLoading, setLogsLoading] = useState(false)

  const loadNodeLogs = useCallback(async () => {
    if (nodeLogs) {
      setLogsOpen(!logsOpen)
      return
    }
    setLogsLoading(true)
    try {
      const resp = await fetch(`/api/employee/tasks/${executionId}/logs?nodeId=${node.nodeId}`)
      const json = await resp.json()
      if (json.success) {
        setNodeLogs(json.data.logs ?? [])
      }
    } catch {
      // ignore
    } finally {
      setLogsLoading(false)
      setLogsOpen(true)
    }
  }, [executionId, node.nodeId, nodeLogs, logsOpen])

  return (
    <div className='flex gap-3'>
      <div className='flex flex-col items-center'>
        <div className='mt-1'>{icon}</div>
        {!isLast && <div className='mt-1 flex-1 border-gray-200 border-l' />}
      </div>
      <div className={`flex-1 pb-4`}>
        <div className='flex items-center gap-2'>
          <span className='font-medium text-gray-900 text-sm'>{node.nodeName}</span>
          <span className='rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500'>
            {typeLabel}
          </span>
          {/* Digital employee node: view logs button */}
          {isDigitalEmployee && (
            <button
              type='button'
              className='ml-auto flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] text-blue-500 hover:bg-blue-50 hover:text-blue-700'
              onClick={loadNodeLogs}
              disabled={logsLoading}
              data-testid={`sop-detail:btn:node-logs:${node.nodeId}`}
            >
              {logsLoading ? (
                <Loader2 className='h-2.5 w-2.5 animate-spin' />
              ) : logsOpen ? (
                <ChevronUp className='h-2.5 w-2.5' />
              ) : (
                <ChevronDown className='h-2.5 w-2.5' />
              )}
              {logsOpen ? t('tasks.detailHideNodeLogs') : t('tasks.detailViewNodeLogs')}
            </button>
          )}
        </div>
        <div className='mt-0.5 flex items-center gap-3 text-gray-400 text-xs'>
          {node.startedAt && (
            <span>{formatTimeOnlyI18n(node.startedAt, locale as SupportedLocale)}</span>
          )}
          {node.startedAt && node.completedAt && (
            <span>{formatDurationFromRange(node.startedAt, node.completedAt)}</span>
          )}
        </div>
        {node.errorMessage && (
          <p className='mt-1 rounded bg-red-50 p-1.5 text-red-600 text-xs'>{node.errorMessage}</p>
        )}

        {/* Approval node: show approval status directly */}
        {isApprovalNode && <ApprovalStatus approval={approval} t={t} />}

        {/* Digital employee node: inline expanded logs */}
        {isDigitalEmployee && logsOpen && nodeLogs && <NodeLogsPanel logs={nodeLogs} t={t} />}
        {isDigitalEmployee && logsLoading && (
          <p className='mt-1.5 text-[10px] text-gray-400'>{t('tasks.detailLogsLoading')}</p>
        )}
      </div>
    </div>
  )
}

/** Approval status display */
function ApprovalStatus({
  approval,
  t,
}: {
  approval?: ApprovalInfo
  t: (key: Parameters<ReturnType<typeof useTranslation>['t']>[0]) => string
}) {
  if (!approval) {
    return (
      <div className='mt-1.5 flex items-center gap-1.5 rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-amber-700 text-xs'>
        <Hourglass className='h-3 w-3' />
        {t('tasks.detailApprovalWaiting')}
      </div>
    )
  }

  if (approval.decision === 'approved') {
    return (
      <div className='mt-1.5 space-y-1'>
        <div className='flex items-center gap-1.5 rounded-md border border-green-200 bg-green-50 px-2 py-1 text-green-700 text-xs'>
          <ThumbsUp className='h-3 w-3' />
          {t('tasks.detailApprovalApproved')}
        </div>
        {approval.comment && (
          <div className='rounded bg-gray-50 px-2 py-1 text-[10px] text-gray-600'>
            <span className='font-medium text-gray-500'>{t('tasks.detailApprovalComment')}:</span>{' '}
            {approval.comment}
          </div>
        )}
      </div>
    )
  }

  if (approval.decision === 'rejected') {
    return (
      <div className='mt-1.5 space-y-1'>
        <div className='flex items-center gap-1.5 rounded-md border border-red-200 bg-red-50 px-2 py-1 text-red-700 text-xs'>
          <ThumbsDown className='h-3 w-3' />
          {t('tasks.detailApprovalRejected')}
        </div>
        {approval.comment && (
          <div className='rounded bg-gray-50 px-2 py-1 text-[10px] text-gray-600'>
            <span className='font-medium text-gray-500'>{t('tasks.detailApprovalComment')}:</span>{' '}
            {approval.comment}
          </div>
        )}
      </div>
    )
  }

  // waiting status
  return (
    <div className='mt-1.5 flex items-center gap-1.5 rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-amber-700 text-xs'>
      <Hourglass className='h-3 w-3' />
      {t('tasks.detailApprovalWaiting')}
    </div>
  )
}

/** Node logs inline panel */
function NodeLogsPanel({
  logs,
  t,
}: {
  logs: NodeLogEntry[]
  t: (key: Parameters<ReturnType<typeof useTranslation>['t']>[0]) => string
}) {
  if (logs.length === 0) {
    return <p className='mt-1.5 text-[10px] text-gray-400'>{t('tasks.detailNoLogs')}</p>
  }

  return (
    <div className='mt-1.5 space-y-1'>
      {logs.map((log) => (
        <LogEntryRow key={log.id} log={log} t={t} />
      ))}
    </div>
  )
}

function InfoItem({
  label,
  value,
  icon,
}: {
  label: string
  value: string
  icon?: React.ReactNode
}) {
  return (
    <div>
      <p className='text-gray-400 text-xs'>{label}</p>
      <p className='mt-0.5 flex items-center gap-1 text-gray-900 text-sm'>
        {icon}
        {value}
      </p>
    </div>
  )
}

// ── JSON tree viewer (VS Code JSON editor style) ──

/** Render a JSON value (recursive) */
function JsonNode({ value, depth = 0 }: { value: unknown; depth?: number }) {
  if (value === null) return <span className='text-[#569cd6]'>null</span>
  if (value === undefined) return <span className='text-[#569cd6]'>undefined</span>
  if (typeof value === 'boolean') return <span className='text-[#569cd6]'>{String(value)}</span>
  if (typeof value === 'number') return <span className='text-[#b5cea8]'>{String(value)}</span>
  if (typeof value === 'string') return <JsonString value={value} />

  if (Array.isArray(value)) {
    return <JsonArray items={value} depth={depth} />
  }

  if (typeof value === 'object') {
    return <JsonObject obj={value as Record<string, unknown>} depth={depth} />
  }

  return <span className='text-[#d4d4d4]'>{String(value)}</span>
}

/** String value - long strings truncatable and expandable */
function JsonString({ value }: { value: string }) {
  const { t } = useTranslation()
  const MAX = 300
  const [expanded, setExpanded] = useState(false)
  const isLong = value.length > MAX

  const display = isLong && !expanded ? `${value.slice(0, MAX)}...` : value

  return (
    <span>
      <span className='text-[#ce9178]'>&quot;{display}&quot;</span>
      {isLong && (
        <button
          type='button'
          className='ml-1 text-[#608b4e] text-[10px] hover:underline'
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? t('tasks.collapse') : `+${value.length - MAX}`}
        </button>
      )}
    </span>
  )
}

/** Object {} - collapsible, expanded by default */
function JsonObject({ obj, depth }: { obj: Record<string, unknown>; depth: number }) {
  const entries = Object.entries(obj)
  const [collapsed, setCollapsed] = useState(false)

  if (entries.length === 0) {
    return <span className='text-[#d4d4d4]'>{'{}'}</span>
  }

  return (
    <span>
      <button
        type='button'
        className='inline-flex items-center text-[#d4d4d4] hover:text-white'
        onClick={() => setCollapsed(!collapsed)}
      >
        <span className='mr-1 inline-block w-3 text-center text-[#858585] text-[10px]'>
          {collapsed ? '▶' : '▼'}
        </span>
        <span>{'{'}</span>
      </button>
      {collapsed ? (
        <span>
          <span className='text-[#858585]'> {entries.length} items </span>
          <span className='text-[#d4d4d4]'>{'}'}</span>
        </span>
      ) : (
        <span>
          <div className='ml-1.5 border-[#404040] border-l pl-3'>
            {entries.map(([key, val], i) => (
              <div key={key}>
                <span className='text-[#9cdcfe]'>&quot;{key}&quot;</span>
                <span className='text-[#d4d4d4]'>: </span>
                <JsonNode value={val} depth={depth + 1} />
                {i < entries.length - 1 && <span className='text-[#d4d4d4]'>,</span>}
              </div>
            ))}
          </div>
          <span className='text-[#d4d4d4]'>{'}'}</span>
        </span>
      )}
    </span>
  )
}

/** Array [] - collapsible, expanded by default */
function JsonArray({ items, depth }: { items: unknown[]; depth: number }) {
  const [collapsed, setCollapsed] = useState(false)

  if (items.length === 0) {
    return <span className='text-[#d4d4d4]'>{'[]'}</span>
  }

  return (
    <span>
      <button
        type='button'
        className='inline-flex items-center text-[#d4d4d4] hover:text-white'
        onClick={() => setCollapsed(!collapsed)}
      >
        <span className='mr-1 inline-block w-3 text-center text-[#858585] text-[10px]'>
          {collapsed ? '▶' : '▼'}
        </span>
        <span>{'['}</span>
      </button>
      {collapsed ? (
        <span>
          <span className='text-[#858585]'> {items.length} items </span>
          <span className='text-[#d4d4d4]'>{']'}</span>
        </span>
      ) : (
        <span>
          <div className='ml-1.5 border-[#404040] border-l pl-3'>
            {items.map((item, i) => (
              <div key={i}>
                <JsonNode value={item} depth={depth + 1} />
                {i < items.length - 1 && <span className='text-[#d4d4d4]'>,</span>}
              </div>
            ))}
          </div>
          <span className='text-[#d4d4d4]'>{']'}</span>
        </span>
      )}
    </span>
  )
}
