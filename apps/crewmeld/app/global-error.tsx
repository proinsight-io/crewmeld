'use client'

import { type Locale, messages } from '@/locales'

/**
 * Detect the operator's preferred locale without depending on the React
 * Provider tree — `global-error.tsx` renders ABOVE every layout and store,
 * so `useTranslation()` is not available here. Reads the same
 * `crewmeld-locale` cookie that `lib/i18n/server-locale.ts` writes; falls
 * back to `navigator.language`; defaults to `en`.
 */
function detectLocale(): Locale {
  if (typeof document === 'undefined') return 'en'
  const cookieMatch = document.cookie.match(/(?:^|;\s*)crewmeld-locale=([^;]+)/)
  if (cookieMatch?.[1]) {
    return decodeURIComponent(cookieMatch[1]).toLowerCase().startsWith('zh') ? 'zh-CN' : 'en'
  }
  const nav = typeof navigator !== 'undefined' ? navigator.language : ''
  return nav.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en'
}

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  const locale = detectLocale()
  const m = messages[locale].common
  return (
    <html lang={locale}>
      <body style={{ fontFamily: 'system-ui, sans-serif', padding: '2rem', textAlign: 'center' }}>
        <h1 style={{ fontSize: '1.5rem', marginBottom: '1rem' }}>{m.globalErrorTitle}</h1>
        <p style={{ color: '#666', marginBottom: '1.5rem' }}>
          {error.digest ? `Reference: ${error.digest}` : m.globalErrorHint}
        </p>
        <button
          type='button'
          onClick={reset}
          style={{
            padding: '0.5rem 1.25rem',
            borderRadius: '0.375rem',
            border: '1px solid #d1d5db',
            background: '#fff',
            cursor: 'pointer',
          }}
        >
          {m.retry}
        </button>
      </body>
    </html>
  )
}
