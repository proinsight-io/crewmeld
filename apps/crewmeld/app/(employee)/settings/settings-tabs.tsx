'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/core/utils/cn'
import { useTranslation } from '@/hooks/use-translation'
import { usePermissions } from '../hooks/use-permissions'

export function SettingsTabs() {
  const pathname = usePathname()
  const { t } = useTranslation()
  const { hasAnyPermission } = usePermissions()

  const tabs: { path: string; name: string; permissions?: string[] }[] = [
    { path: '/settings/preferences', name: t('settings.tabPreferences') },
    {
      path: '/settings/users',
      name: t('settings.tabUsers'),
      permissions: ['user:list', 'user:role_edit', 'user:status_edit', 'user:approval'],
    },
    {
      path: '/settings/roles',
      name: t('settings.tabRoles'),
      permissions: ['role:view', 'role:edit'],
    },
    {
      path: '/settings/registration',
      name: t('settings.tabRegistration'),
      permissions: ['registration:view', 'registration:edit'],
    },
    {
      path: '/settings/sandbox',
      name: t('settings.tabSandbox'),
      permissions: ['sandbox:view', 'sandbox:edit'],
    },
    {
      path: '/settings/system',
      name: t('settings.tabSystemInfo'),
      permissions: ['system:view', 'system:health_check', 'license:view', 'license:upload'],
    },
  ]

  return (
    <div className='mb-6 border-gray-200 border-b'>
      <nav className='-mb-px flex gap-6'>
        {tabs.map((tab) => {
          if (tab.permissions && !hasAnyPermission(tab.permissions)) {
            return null
          }
          const isActive = pathname.startsWith(tab.path)
          return (
            <Link
              key={tab.path}
              href={tab.path}
              className={cn(
                'border-b-2 pb-3 font-medium text-sm transition-colors',
                isActive
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700'
              )}
            >
              {tab.name}
            </Link>
          )
        })}
      </nav>
    </div>
  )
}
