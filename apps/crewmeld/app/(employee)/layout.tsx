'use client'

import { memo, type ReactNode, useCallback, useEffect } from 'react'
import {
  BarChart3,
  BookOpen,
  ChevronsUpDown,
  ClipboardList,
  GitBranch,
  Link2,
  LogOut,
  MessageSquare,
  Radio,
  Settings,
  Shield,
  Sparkles,
  TrendingUp,
  UserCheck,
  Users,
} from 'lucide-react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { signOut, useSession } from '@/lib/auth/auth-client'
import { cn } from '@/lib/core/utils/cn'
import type { TranslationKey } from '@/hooks/use-translation'
import { useTranslation } from '@/hooks/use-translation'
import { NotificationCenter } from './components/notifications/notification-center'
import { usePermissions } from './hooks/use-permissions'
import { usePendingCount } from './tasks/hooks/use-pending-count'

interface NavItem {
  path: string
  nameKey: TranslationKey
  icon: typeof BarChart3
  /** Permissions for this menu - visible if user has any; empty means visible to all */
  permissions?: string[]
}

const NAV_ITEMS: ReadonlyArray<NavItem> = [
  { path: '/dashboard', nameKey: 'nav.dashboard', icon: BarChart3 },
  {
    path: '/employees',
    nameKey: 'nav.employees',
    icon: Users,
    permissions: ['employee:list', 'employee:create', 'employee:edit', 'employee:delete'],
  },
  {
    path: '/tasks',
    nameKey: 'nav.tasks',
    icon: ClipboardList,
    permissions: ['task:list', 'task:create', 'task:cancel'],
  },
  { path: '/conversations', nameKey: 'nav.conversations', icon: MessageSquare },
  { path: '/stats', nameKey: 'nav.stats', icon: TrendingUp, permissions: ['employee:list'] },
  {
    path: '/knowledge',
    nameKey: 'nav.knowledge',
    icon: BookOpen,
    permissions: ['knowledge:list', 'knowledge:create', 'knowledge:edit', 'knowledge:delete'],
  },
  {
    path: '/connections',
    nameKey: 'nav.connections',
    icon: Link2,
    permissions: ['connector:list', 'connector:create', 'connector:edit', 'connector:delete'],
  },
  {
    path: '/channels',
    nameKey: 'nav.channels',
    icon: Radio,
    permissions: ['channel:list', 'channel:create', 'channel:edit', 'channel:delete'],
  },
  {
    path: '/human-employees',
    nameKey: 'nav.humanEmployees',
    icon: UserCheck,
    permissions: ['employee:list', 'employee:edit'],
  },
  {
    path: '/sops',
    nameKey: 'nav.sops',
    icon: GitBranch,
    permissions: ['sop:list', 'sop:create', 'sop:edit', 'sop:delete'],
  },
  { path: '/logs', nameKey: 'nav.logs', icon: Shield, permissions: ['system:view'] },
  {
    path: '/skills',
    nameKey: 'nav.skills',
    icon: Sparkles,
    permissions: ['skill:list', 'skill:create', 'skill:edit', 'skill:delete', 'skill:deploy'],
  },
  {
    path: '/settings',
    nameKey: 'nav.settings',
    icon: Settings,
    permissions: ['user:list', 'role:view', 'registration:view', 'system:view'],
  },
]

const ALL_NAV_PATHS = NAV_ITEMS.map((i) => i.path)

function getActiveNavPath(pathname: string): string | undefined {
  return ALL_NAV_PATHS.filter((p) => pathname === p || pathname.startsWith(`${p}/`)).sort(
    (a, b) => b.length - a.length
  )[0]
}

// Sidebar nav list - separate component, filters menu items by permissions
const SidebarNav = memo(function SidebarNav({
  pathname,
  pendingCount,
  hasAnyPermission,
}: {
  pathname: string
  pendingCount: number
  hasAnyPermission: (codes: string[]) => boolean
}) {
  const activePath = getActiveNavPath(pathname)
  const { t } = useTranslation()
  return (
    <ScrollArea className='flex-1'>
      <nav className='space-y-1 p-3'>
        {NAV_ITEMS.map((item) => {
          // When permissions required, must have at least one to be shown
          if (item.permissions && !hasAnyPermission(item.permissions)) {
            return null
          }
          const isActive = activePath === item.path
          const Icon = item.icon
          return (
            <Link
              key={item.path}
              href={item.path}
              className={cn(
                'flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
                isActive
                  ? 'bg-blue-50 font-medium text-blue-700'
                  : 'text-gray-600 hover:bg-gray-100 hover:text-gray-700'
              )}
            >
              <Icon className='h-4 w-4 shrink-0' />
              {t(item.nameKey)}
              {item.path === '/tasks' && pendingCount > 0 && (
                <span className='ml-auto inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-red-500 px-1.5 font-medium text-white text-xs'>
                  {pendingCount > 99 ? '99+' : pendingCount}
                </span>
              )}
            </Link>
          )
        })}
      </nav>
    </ScrollArea>
  )
})

interface EmployeeLayoutProps {
  children: ReactNode
}

export default function EmployeeLayout({ children }: EmployeeLayoutProps) {
  const pathname = usePathname()
  const router = useRouter()
  const { data: session, isPending } = useSession()
  const { count: pendingCount } = usePendingCount()
  const { hasAnyPermission } = usePermissions()
  const { t } = useTranslation()

  const user = session?.user
  const userInitial = user?.name?.slice(0, 1) ?? '?'

  useEffect(() => {
    if (!isPending && !user) {
      router.push('/login')
    }
  }, [isPending, user, router])

  const handleSignOut = useCallback(async () => {
    await signOut()
    router.push('/login')
  }, [router])

  return (
    <div className='flex min-h-screen bg-white'>
      <aside className='fixed top-0 left-0 z-10 flex h-screen w-56 flex-col border-gray-200 border-r bg-white'>
        <div className='flex h-14 items-center px-5'>
          <span className='font-semibold text-gray-900 text-lg'>CrewMeld</span>
        </div>
        <Separator />
        <SidebarNav
          pathname={pathname}
          pendingCount={pendingCount}
          hasAnyPermission={hasAnyPermission}
        />
        {user && (
          <>
            <Separator />
            <div className='p-3'>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type='button'
                    className='flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left text-sm hover:bg-gray-100'
                  >
                    <div className='flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gray-200 font-medium text-gray-600 text-sm'>
                      {user.image ? (
                        <img
                          src={user.image}
                          alt={user.name ?? ''}
                          className='h-8 w-8 rounded-full object-cover'
                        />
                      ) : (
                        userInitial
                      )}
                    </div>
                    <div className='min-w-0 flex-1'>
                      <p className='truncate font-medium text-gray-900 text-sm'>{user.name}</p>
                      <p className='truncate text-gray-400 text-xs'>{user.email}</p>
                    </div>
                    <ChevronsUpDown className='h-4 w-4 shrink-0 text-gray-400' />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align='start' side='top' className='w-56'>
                  <DropdownMenuLabel className='font-normal'>
                    <p className='font-medium text-sm'>{user.name}</p>
                    <p className='text-gray-500 text-xs'>{user.email}</p>
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={handleSignOut}>
                    <LogOut className='mr-2 h-4 w-4' />
                    {t('userMenu.signOut')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </>
        )}
      </aside>
      <main className='ml-56 flex-1 p-6'>{children}</main>
      <NotificationCenter />
    </div>
  )
}
