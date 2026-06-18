'use client'

import { useState } from 'react'
import { Calendar, FlaskConical, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/use-translation'
import { PermissionGuard } from '../components/permission-guard'
import { SandboxRunDetailDrawer } from './components/sandbox-run-detail-drawer'
import { SandboxRunTable } from './components/sandbox-run-table'
import { ScheduledTaskForm } from './components/scheduled-task-form'
import { ScheduledTaskRunsDrawer } from './components/scheduled-task-runs-drawer'
import { ScheduledTaskTable } from './components/scheduled-task-table'
import { TaskDetailDrawer } from './components/task-detail-drawer'
import { TaskFilters } from './components/task-filters'
import { TaskTable } from './components/task-table'
import { useSandboxRuns } from './hooks/use-sandbox-runs'
import { useScheduledTasks } from './hooks/use-scheduled-tasks'
import { useTasks } from './hooks/use-tasks'
import type {
  SandboxRunListItem,
  ScheduledTaskItem,
  SopExecutionListItem,
  TaskFilterState,
  TaskTab,
} from './types'

export default function TaskCenterPage() {
  const { t } = useTranslation()

  const TABS: { key: TaskTab; label: string; icon?: React.ReactNode }[] = [
    { key: 'running', label: t('tasks.tabRunning') },
    {
      key: 'scheduled',
      label: t('tasks.tabScheduled'),
      icon: <Calendar className='h-3.5 w-3.5 text-blue-500' />,
    },
    { key: 'history', label: t('tasks.tabHistory') },
    {
      key: 'sandbox',
      label: t('tasks.tabSandbox'),
      icon: <FlaskConical className='h-3.5 w-3.5 text-amber-500' />,
    },
  ]
  const [activeTab, setActiveTab] = useState<TaskTab>('running')
  const [selectedExecutionId, setSelectedExecutionId] = useState<string | null>(null)
  const [selectedSandboxRunId, setSelectedSandboxRunId] = useState<string | null>(null)
  const [filters, setFilters] = useState<TaskFilterState>({
    status: [],
    sopId: '',
    dateFrom: '',
    dateTo: '',
  })
  const [page, setPage] = useState(1)
  const [sandboxPage, setSandboxPage] = useState(1)
  const [scheduledPage, setScheduledPage] = useState(1)
  const [scheduledFormOpen, setScheduledFormOpen] = useState(false)
  const [editingScheduledTask, setEditingScheduledTask] = useState<ScheduledTaskItem | null>(null)
  const [selectedScheduledTask, setSelectedScheduledTask] = useState<ScheduledTaskItem | null>(null)
  const [toast, setToast] = useState<{ type: 'success' | 'info'; message: string } | null>(null)

  const statusForTab =
    activeTab === 'running'
      ? 'pending,running,paused_for_human,paused_for_tool'
      : filters.status.length > 0
        ? filters.status.join(',')
        : 'completed,failed,timed_out,cancelled,error'

  const { data, isLoading, error, refetch } = useTasks({
    status: activeTab !== 'sandbox' ? statusForTab : undefined,
    sopId: filters.sopId || undefined,
    dateFrom: activeTab === 'history' ? filters.dateFrom || undefined : undefined,
    dateTo: activeTab === 'history' ? filters.dateTo || undefined : undefined,
    page,
    pageSize: 20,
    autoRefresh: activeTab === 'running',
  })

  const {
    data: sandboxData,
    isLoading: sandboxLoading,
    error: sandboxError,
    refetch: sandboxRefetch,
  } = useSandboxRuns({
    page: sandboxPage,
    pageSize: 20,
  })

  const {
    data: scheduledData,
    isLoading: scheduledLoading,
    error: scheduledError,
    refetch: scheduledRefetch,
  } = useScheduledTasks({ page: scheduledPage, pageSize: 20 })

  const showToast = (type: 'success' | 'info', message: string) => {
    setToast({ type, message })
    setTimeout(() => setToast(null), 3000)
  }

  const handleScheduledExecute = async (item: ScheduledTaskItem) => {
    try {
      const res = await fetch(`/api/employee/scheduled-tasks/${item.id}/execute`, {
        method: 'POST',
      })
      const json = await res.json()
      if (json.success) {
        showToast('success', t('tasks.executeTriggered', { name: item.name }))
        scheduledRefetch()
      } else {
        showToast('info', json.error ?? t('tasks.executeFailed'))
      }
    } catch {
      showToast('info', t('tasks.executeFailed'))
    }
  }

  const handleScheduledToggle = async (item: ScheduledTaskItem) => {
    try {
      const res = await fetch(`/api/employee/scheduled-tasks/${item.id}/toggle`, { method: 'POST' })
      const json = await res.json()
      if (json.success) {
        showToast(
          'success',
          t('tasks.toggled', {
            name: item.name,
            action: json.data.isActive ? t('common.enabled') : t('common.disabled'),
          })
        )
        scheduledRefetch()
      } else {
        showToast('info', json.error ?? t('common.operationFailed'))
      }
    } catch {
      showToast('info', t('common.operationFailed'))
    }
  }

  const handleScheduledDelete = async (item: ScheduledTaskItem) => {
    if (!confirm(t('tasks.deleteConfirm', { name: item.name }))) return
    try {
      const res = await fetch(`/api/employee/scheduled-tasks/${item.id}`, { method: 'DELETE' })
      const json = await res.json()
      if (json.success) {
        showToast('success', t('tasks.deleteSuccess', { name: item.name }))
        scheduledRefetch()
      } else {
        showToast('info', json.error ?? t('tasks.deleteFailed'))
      }
    } catch {
      showToast('info', t('tasks.deleteFailed'))
    }
  }

  const handleRowClick = (item: SopExecutionListItem) => {
    setSelectedExecutionId(item.id)
  }

  const handleSandboxRowClick = (item: SandboxRunListItem) => {
    setSelectedSandboxRunId(item.id)
  }

  const handleTabChange = (tab: TaskTab) => {
    setActiveTab(tab)
    setPage(1)
    setSandboxPage(1)
    setScheduledPage(1)
    setSelectedExecutionId(null)
    setSelectedSandboxRunId(null)
    setSelectedScheduledTask(null)
  }

  return (
    <div className='p-6'>
      <div className='mb-6 flex items-center justify-between'>
        <h1 className='font-bold text-2xl text-gray-900'>{t('tasks.title')}</h1>
        {activeTab === 'scheduled' && (
          <PermissionGuard requires='sop:create'>
            <Button
              onClick={() => {
                setEditingScheduledTask(null)
                setScheduledFormOpen(true)
              }}
              className='bg-violet-600 hover:bg-violet-700'
              data-testid='scheduled-task:button:create'
            >
              <Plus className='mr-2 h-4 w-4' />
              {t('tasks.createScheduled')}
            </Button>
          </PermissionGuard>
        )}
      </div>

      <div className='mb-4 flex gap-1 rounded-lg bg-gray-100 p-1'>
        {TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => handleTabChange(tab.key)}
            data-testid={`nav:tab:${tab.key}`}
            className={`flex items-center gap-1.5 rounded-md px-4 py-2 font-medium text-sm transition-colors ${
              activeTab === tab.key
                ? 'bg-white text-gray-900 shadow-sm'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'history' && (
        <TaskFilters
          filters={filters}
          onChange={(newFilters) => {
            setFilters(newFilters)
            setPage(1)
          }}
        />
      )}

      {activeTab === 'scheduled' ? (
        <ScheduledTaskTable
          items={scheduledData?.data ?? []}
          isLoading={scheduledLoading}
          error={scheduledError}
          pagination={scheduledData?.pagination ?? null}
          onPageChange={setScheduledPage}
          onRowClick={(item) => setSelectedScheduledTask(item)}
          onEdit={(item) => {
            setEditingScheduledTask(item)
            setScheduledFormOpen(true)
          }}
          onExecute={handleScheduledExecute}
          onToggle={handleScheduledToggle}
          onDelete={handleScheduledDelete}
          onRetry={scheduledRefetch}
        />
      ) : activeTab === 'sandbox' ? (
        <SandboxRunTable
          items={sandboxData?.data ?? []}
          isLoading={sandboxLoading}
          error={sandboxError}
          onRowClick={handleSandboxRowClick}
          pagination={sandboxData?.pagination ?? null}
          onPageChange={setSandboxPage}
          onRetry={sandboxRefetch}
        />
      ) : (
        <TaskTable
          items={data?.data ?? []}
          isLoading={isLoading}
          error={error}
          onRowClick={handleRowClick}
          pagination={data?.pagination ?? null}
          onPageChange={setPage}
          showAutoRefreshIndicator={activeTab === 'running'}
          onRetry={refetch}
        />
      )}

      {selectedExecutionId && (
        <TaskDetailDrawer
          executionId={selectedExecutionId}
          onClose={() => setSelectedExecutionId(null)}
        />
      )}

      {selectedSandboxRunId && (
        <SandboxRunDetailDrawer
          runId={selectedSandboxRunId}
          onClose={() => setSelectedSandboxRunId(null)}
        />
      )}

      {/* Scheduled task create/edit form */}
      <ScheduledTaskForm
        open={scheduledFormOpen}
        editingTask={editingScheduledTask}
        onClose={() => {
          setScheduledFormOpen(false)
          setEditingScheduledTask(null)
        }}
        onSaved={scheduledRefetch}
      />

      {/* Scheduled task runs sidebar */}
      {selectedScheduledTask && (
        <ScheduledTaskRunsDrawer
          task={selectedScheduledTask}
          onClose={() => setSelectedScheduledTask(null)}
        />
      )}

      {/* Toast */}
      {toast && (
        <div className='-translate-x-1/2 fixed top-16 left-1/2 z-50 flex items-center gap-3 rounded-xl border border-green-200 bg-green-50 px-5 py-3 text-green-800 shadow-lg'>
          <span className='font-medium text-sm'>{toast.message}</span>
        </div>
      )}
    </div>
  )
}
