'use client'

import { useCallback, useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { PersonaEditor } from '@/components/employee/persona-editor'
import { EmployeeHeader } from '@/components/employee-detail/employee-header'
import { KnowledgeTab } from '@/components/employee-detail/knowledge-tab'
import { LogsTab } from '@/components/employee-detail/logs-tab'
import { OverviewTab } from '@/components/employee-detail/overview-tab'
import { useTranslation } from '@/hooks/use-translation'
import type { TranslationKey } from '@/locales'
import { ConnectionsTab } from './components/connections-tab'
import { SkillBindingsTab } from './components/skill-bindings-tab'

interface BoundModel {
  id: string
  providerId: string
  displayName: string
  modelName: string | null
  isActive: boolean
}

interface EmployeeDetail {
  id: string
  name: string
  avatar: string | null
  description: string | null
  blockType: string
  status: string
  workflowId: string | null
  modelConfigId: string | null
  boundModel: BoundModel | null
  config: Record<string, unknown>
  skillBindingCount: number
  knowledgeBindingCount: number
  connectionBindingCount: number
  activatedAt: string | null
  createdAt: string
  updatedAt: string
}

const BASE_TAB_KEYS = [
  { key: 'overview', labelKey: 'employees.tabOverview' as TranslationKey },
  { key: 'logs', labelKey: 'employees.tabLogs' as TranslationKey },
  { key: 'skill-bindings', labelKey: 'employees.tabSkillBindings' as TranslationKey },
  { key: 'knowledge', labelKey: 'employees.tabKnowledge' as TranslationKey },
  { key: 'connections', labelKey: 'employees.tabConnections' as TranslationKey },
  { key: 'persona', labelKey: 'employees.tabPersona' as TranslationKey },
] as const

type TabKey = (typeof BASE_TAB_KEYS)[number]['key']

export default function EmployeeDetailPage() {
  const params = useParams()
  const router = useRouter()
  const employeeId = params.id as string

  const { t, tMessage } = useTranslation()
  const [activeTab, setActiveTab] = useState<TabKey>('overview')
  const [employee, setEmployee] = useState<EmployeeDetail | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchEmployee = useCallback(async () => {
    try {
      const res = await fetch(`/api/employee/employees/${employeeId}`)
      if (!res.ok) {
        if (res.status === 404) {
          setError(t('employees.notFound'))
        } else {
          setError(t('employees.loadFailed'))
        }
        return
      }
      const json = await res.json()
      setEmployee(json.data)
    } catch {
      setError(t('employees.networkErrorRetry'))
    } finally {
      setIsLoading(false)
    }
  }, [employeeId])

  useEffect(() => {
    fetchEmployee()
  }, [fetchEmployee])

  const handleDelete = async () => {
    const res = await fetch(`/api/employee/employees/${employeeId}`, {
      method: 'DELETE',
    })
    if (!res.ok) {
      const json = await res.json()
      throw new Error(tMessage(json) || t('employees.deleteFailed'))
    }
    const name = employee?.name ?? ''
    router.push(`/employees?deleted=1&name=${encodeURIComponent(name)}`)
  }

  if (isLoading) {
    return (
      <div className='min-h-screen bg-gray-50'>
        <div className='border-gray-200 border-b bg-white px-6 py-5'>
          <div className='flex items-center gap-4'>
            <div className='h-12 w-12 animate-pulse rounded-full bg-gray-200' />
            <div className='space-y-2'>
              <div className='h-6 w-40 animate-pulse rounded bg-gray-200' />
              <div className='h-4 w-60 animate-pulse rounded bg-gray-200' />
            </div>
          </div>
        </div>
        <div className='p-6'>
          <div className='grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3'>
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className='h-28 animate-pulse rounded-lg bg-gray-200' />
            ))}
          </div>
        </div>
      </div>
    )
  }

  const tabs = BASE_TAB_KEYS.map((tab) => ({ key: tab.key, label: t(tab.labelKey) }))

  if (error || !employee) {
    return (
      <div className='flex min-h-screen items-center justify-center bg-gray-50'>
        <div className='text-center'>
          <p className='text-gray-500 text-lg'>{error ?? t('employees.notFound')}</p>
          <button
            onClick={() => router.push('/employees')}
            className='mt-4 text-blue-600 text-sm hover:underline'
          >
            {t('employees.backToList')}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className='min-h-screen bg-gray-50'>
      <EmployeeHeader employee={employee} onDelete={handleDelete} onUpdate={fetchEmployee} />

      <div className='border-gray-200 border-b bg-white px-6'>
        <nav className='flex gap-8'>
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`border-b-2 px-1 py-4 font-medium text-sm transition-colors ${
                activeTab === tab.key
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      <div className='p-6'>
        {activeTab === 'overview' && (
          <OverviewTab
            employeeId={employeeId}
            knowledgeBindingCount={employee.knowledgeBindingCount}
            boundModelName={employee.boundModel?.displayName ?? null}
          />
        )}
        {activeTab === 'logs' && <LogsTab employeeId={employeeId} />}
        {activeTab === 'skill-bindings' && <SkillBindingsTab employeeId={employeeId} />}
        {activeTab === 'knowledge' && (
          <KnowledgeTab
            employeeId={employeeId}
            ragflowDatasetIds={
              Array.isArray((employee.config as Record<string, unknown>)?.ragflowDatasetIds)
                ? ((employee.config as Record<string, unknown>).ragflowDatasetIds as string[])
                : []
            }
            onUpdate={fetchEmployee}
          />
        )}
        {activeTab === 'connections' && (
          <ConnectionsTab
            employeeId={employeeId}
            boundModel={employee.boundModel}
            onModelChange={fetchEmployee}
          />
        )}
        {activeTab === 'persona' && <PersonaEditor employeeId={employeeId} />}
      </div>
    </div>
  )
}
