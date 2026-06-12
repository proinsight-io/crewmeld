import type { Metadata, Viewport } from 'next'
import { PublicEnvScript } from 'next-runtime-env'
import { QueryProvider } from '@/app/_shell/providers/query-provider'
import { SessionProvider } from '@/app/_shell/providers/session-provider'
import { inter } from '@/app/_styles/fonts/inter/inter'
import '@/app/_styles/globals.css'

/**
 * Root layout for P0. Ports the minimum shell required to mount the session +
 * query providers; the full upstream layout adds PostHog, theme toggles,
 * whitelabel branding, etc. — those land in P1.
 */

// PublicEnvScript injects NEXT_PUBLIC_* into window.__ENV at request time so the
// client reads them at RUNTIME (via next-runtime-env's getEnv) instead of the
// build-time inlined values. force-dynamic guarantees the script captures the
// running container's env rather than build-time defaults — required for the app
// to be reachable under any host (e.g. a LAN IP) without rebuilding the image.
export const dynamic = 'force-dynamic'

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#0c0c0c' },
  ],
}

export const metadata: Metadata = {
  title: 'CrewMeld',
  description: 'Enterprise AI digital employee platform',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang='zh-CN' className={inter.variable} suppressHydrationWarning>
      <head>
        <PublicEnvScript />
      </head>
      <body
        className='min-h-screen bg-background text-foreground antialiased'
        suppressHydrationWarning
      >
        <QueryProvider>
          <SessionProvider>{children}</SessionProvider>
        </QueryProvider>
      </body>
    </html>
  )
}
