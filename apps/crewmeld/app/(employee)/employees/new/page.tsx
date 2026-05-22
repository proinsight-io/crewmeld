'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createLogger } from '@crewmeld/logger'
import { useRouter } from 'next/navigation'
import type { FlatRole } from '@/lib/types/role'
import { getLocalizedBuiltinRoles, isBuiltinRoleId } from '@/data/builtin-roles'
import { useTranslation } from '@/hooks/use-translation'
import { useLocaleStore } from '@/stores/locale/store'
import { Step2BasicSettings } from './components/step2-basic-settings'
import { Step3BindTools } from './components/step3-bind-tools'
import { Step4KnowledgeBase } from './components/step4-knowledge-base'
import { Step5BindModel } from './components/step5-bind-model'
import { Step5TestRun } from './components/step5-test-run'
import { WizardLayout } from './components/wizard-layout'
import type { CreatedEmployee, EmployeeConfig, TestRunResult } from './types'

const logger = createLogger('EmployeeWizard')

export default function EmployeeWizardPage() {
  const { t } = useTranslation()
  const locale = useLocaleStore((s) => s.locale)
  const router = useRouter()
  const [currentStep, setCurrentStep] = useState(1)

  // Custom roles come from the API; built-in roles are static frontend data
  const [customRoles, setCustomRoles] = useState<FlatRole[]>([])
  const [isLoadingRoles, setIsLoadingRoles] = useState(true)
  const builtinRoles = useMemo(() => getLocalizedBuiltinRoles(locale), [locale])
  const flatRoles = useMemo<FlatRole[]>(
    () => [...customRoles, ...builtinRoles],
    [customRoles, builtinRoles]
  )

  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null)
  const [selectedRoleName, setSelectedRoleName] = useState<string | null>(null)

  const [employeeConfig, setEmployeeConfig] = useState<EmployeeConfig>({
    name: '',
    description: '',
    avatar: '🤖',
    persona: '',
  })

  // Track the last auto-filled values to detect whether the user manually modified the form
  const [autoFilledConfig, setAutoFilledConfig] = useState({
    name: '',
    description: '',
    persona: '',
  })

  const [selectedSkillInstanceIds, setSelectedSkillInstanceIds] = useState<string[]>([])
  const [selectedKBIds, setSelectedKBIds] = useState<string[]>([])
  const [selectedRagflowDatasetIds, setSelectedRagflowDatasetIds] = useState<string[]>([])
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null)

  const [createdEmployeeId, setCreatedEmployeeId] = useState<string | null>(null)
  const [createdEmployees] = useState<CreatedEmployee[]>([])
  const [testRunResult, setTestRunResult] = useState<TestRunResult | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    async function loadRoles() {
      try {
        const res = await fetch('/api/employee/roles')
        const json = await res.json()
        if (json.success) {
          setCustomRoles(json.data as FlatRole[])
        }
      } finally {
        setIsLoadingRoles(false)
      }
    }
    loadRoles()
  }, [])

  const reloadRoles = useCallback(async () => {
    try {
      const res = await fetch('/api/employee/roles')
      const json = await res.json()
      if (json.success) {
        setCustomRoles(json.data as FlatRole[])
      }
    } catch {
      // Silent failure
    }
  }, [])

  const handleRoleDeleted = useCallback(
    async (role: FlatRole) => {
      if (isBuiltinRoleId(role.id)) {
        throw new Error(t('employees.builtinRoleCannotDelete'))
      }
      const res = await fetch(`/api/employee/roles/${role.id}`, { method: 'DELETE' })
      if (!res.ok) {
        const json = await res.json()
        throw new Error(json.error ?? t('employees.deleteFailed'))
      }
      await reloadRoles()
      if (selectedRoleId === role.id) {
        setSelectedRoleId(null)
        setSelectedRoleName(null)
      }
    },
    [reloadRoles, selectedRoleId, t]
  )

  const handleRoleCreated = useCallback(
    async (role: FlatRole) => {
      await reloadRoles()
      setSelectedRoleId(role.id)
      setSelectedRoleName(role.name)
      const rolePersona = role.persona ?? ''
      const roleDescription = role.description ?? ''
      setAutoFilledConfig({ name: role.name, description: roleDescription, persona: rolePersona })
      setEmployeeConfig((prev) => ({
        ...prev,
        name: !prev.name || prev.name === autoFilledConfig.name ? role.name : prev.name,
        description:
          !prev.description || prev.description === autoFilledConfig.description
            ? roleDescription
            : prev.description,
        persona:
          !prev.persona || prev.persona === autoFilledConfig.persona ? rolePersona : prev.persona,
      }))
    },
    [reloadRoles, autoFilledConfig]
  )

  const handleDeselectRole = useCallback(() => {
    setSelectedRoleId(null)
    setSelectedRoleName(null)
  }, [])

  const handleSelectRole = useCallback(
    (role: FlatRole) => {
      setSelectedRoleId(role.id)
      setSelectedRoleName(role.name)
      const rolePersona = role.persona ?? ''
      const roleDescription = role.description ?? ''
      setAutoFilledConfig({ name: role.name, description: roleDescription, persona: rolePersona })
      setEmployeeConfig((prev) => ({
        ...prev,
        name: !prev.name || prev.name === autoFilledConfig.name ? role.name : prev.name,
        description:
          !prev.description || prev.description === autoFilledConfig.description
            ? roleDescription
            : prev.description,
        persona:
          !prev.persona || prev.persona === autoFilledConfig.persona ? rolePersona : prev.persona,
      }))
    },
    [autoFilledConfig]
  )

  const canGoNext = (() => {
    switch (currentStep) {
      // Step 1 (role + basic settings): allow advancing even without a role
      // selected so the user can also fill the name manually on step 1 or
      // proceed to fill it on step 2 via the basic settings form.
      case 1:
      case 2:
      case 3:
        return true
      case 4:
        return selectedModelId !== null
      case 5:
        return testRunResult !== null
      default:
        return false
    }
  })()

  const handleNext = useCallback(async () => {
    if (currentStep === 4) {
      if (!createdEmployeeId) {
        setIsSubmitting(true)
        setError(null)
        try {
          const res = await fetch('/api/employee/employees', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              roleId: selectedRoleId,
              name: employeeConfig.name.trim(),
              description: employeeConfig.description.trim() || undefined,
              persona: employeeConfig.persona.trim() || undefined,
              avatar: employeeConfig.avatar,
              knowledgeBaseIds: selectedKBIds,
              modelConfigId: selectedModelId || undefined,
              config:
                selectedRagflowDatasetIds.length > 0
                  ? { ragflowDatasetIds: selectedRagflowDatasetIds }
                  : undefined,
            }),
          })
          const json = await res.json()
          if (json.success) {
            const newEmployeeId = json.data.id
            setCreatedEmployeeId(newEmployeeId)
            // Batch-bind tool instances
            await Promise.allSettled(
              selectedSkillInstanceIds.map((instanceId) =>
                fetch('/api/employee/skills/bindings', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ employeeId: newEmployeeId, instanceId }),
                })
              )
            )
          } else {
            setError(json.error ?? t('employees.wizardCreateFailed'))
            return
          }
        } catch {
          setError(t('employees.wizardNetworkError'))
          return
        } finally {
          setIsSubmitting(false)
        }
      }
    }
    if (currentStep < 5) {
      setCurrentStep(currentStep + 1)
    }
  }, [
    currentStep,
    createdEmployeeId,
    selectedRoleId,
    employeeConfig,
    selectedKBIds,
    selectedRagflowDatasetIds,
    selectedModelId,
    selectedSkillInstanceIds,
    t,
  ])

  const handlePrevious = useCallback(() => {
    if (currentStep > 1) {
      setCurrentStep(currentStep - 1)
    }
  }, [currentStep])

  const handleRunTest = useCallback(async (employeeId: string, input: Record<string, unknown>) => {
    setTestRunResult(null)
    try {
      const res = await fetch(`/api/employee/employees/${employeeId}/test-run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input }),
      })
      const json = await res.json()
      if (json.success) {
        setTestRunResult(json.data)
      }
    } catch {
      setTestRunResult({
        executionId: 'error',
        status: 'failed',
        output: { error: t('employees.testRunRequestFailed') },
        logs: [
          {
            timestamp: new Date().toISOString(),
            level: 'error',
            message: t('employees.wizardNetworkError'),
          },
        ],
        duration: 0,
      })
    }
  }, [])

  const handleFinish = useCallback(async () => {
    if (createdEmployeeId) {
      router.push(`/employees/${createdEmployeeId}`)
    } else {
      router.push('/employees')
    }
  }, [createdEmployeeId, router])

  return (
    <div>
      <div className='mb-6 flex items-center justify-between'>
        <h1 className='font-bold text-2xl text-gray-900'>{t('employees.wizardTitle')}</h1>
        <button
          type='button'
          onClick={() => router.push('/employees')}
          className='flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-gray-600 text-sm hover:bg-gray-50 hover:text-gray-800'
        >
          <svg
            xmlns='http://www.w3.org/2000/svg'
            className='h-4 w-4'
            fill='none'
            viewBox='0 0 24 24'
            stroke='currentColor'
            strokeWidth={2}
          >
            <path strokeLinecap='round' strokeLinejoin='round' d='M15 19l-7-7 7-7' />
          </svg>
          {t('employees.wizardBack')}
        </button>
      </div>

      {error && (
        <div className='mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-red-600 text-sm'>
          {error}
        </div>
      )}

      <WizardLayout
        currentStep={currentStep}
        canGoNext={canGoNext}
        canGoPrevious={currentStep > 1}
        isSubmitting={isSubmitting}
        onPrevious={handlePrevious}
        onNext={handleNext}
        onFinish={handleFinish}
      >
        {currentStep === 1 && (
          <Step2BasicSettings
            flatRoles={flatRoles}
            isLoadingTemplates={isLoadingRoles}
            selectedRoleName={selectedRoleName}
            onSelectRole={handleSelectRole}
            onDeselectRole={handleDeselectRole}
            onRoleCreated={handleRoleCreated}
            onRoleDeleted={handleRoleDeleted}
            config={employeeConfig}
            onConfigChange={setEmployeeConfig}
          />
        )}
        {currentStep === 2 && (
          <Step3BindTools
            selectedInstanceIds={selectedSkillInstanceIds}
            onSelectionChange={setSelectedSkillInstanceIds}
          />
        )}
        {currentStep === 3 && (
          <Step4KnowledgeBase
            selectedKBIds={selectedKBIds}
            onSelectionChange={setSelectedKBIds}
            selectedRagflowDatasetIds={selectedRagflowDatasetIds}
            onRagflowSelectionChange={setSelectedRagflowDatasetIds}
          />
        )}
        {currentStep === 4 && (
          <Step5BindModel selectedModelId={selectedModelId} onSelectModel={setSelectedModelId} />
        )}
        {currentStep === 5 && (
          <Step5TestRun
            mode='single'
            employeeId={createdEmployeeId}
            createdEmployees={createdEmployees}
            employeeName={employeeConfig.name}
            testResult={testRunResult}
            onRunTest={handleRunTest}
          />
        )}
      </WizardLayout>
    </div>
  )
}
