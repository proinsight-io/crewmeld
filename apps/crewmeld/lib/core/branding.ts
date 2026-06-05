import type { Metadata } from 'next'

/**
 * Brand configuration for CrewMeld.
 *
 * Drop-in replacement for the legacy `ee/whitelabeling` module.
 * All values are hardcoded constants; runtime environment-variable overrides
 * are intentionally not supported in this build.
 *
 * Any consumer that imported `@/ee/whitelabeling` in the legacy codebase
 * should now import `@/lib/core/branding` with identical named exports:
 *
 *   - type `BrandConfig`
 *   - type `ThemeColors`
 *   - `getBrandConfig()`
 *   - `useBrandConfig()`
 *   - `generateThemeCSS()`
 *   - `generateBrandedMetadata()`
 *   - `generateStructuredData()`
 *
 * Additional constants (`BRAND_NAME`, `brand`, etc.) are also exported for
 * code that wants to reference brand values without going through the
 * function wrapper.
 */

/** Theme color tokens used to render the light/dark brand palette. */
export interface ThemeColors {
  primaryColor?: string
  primaryHoverColor?: string
  accentColor?: string
  accentHoverColor?: string
  backgroundColor?: string
}

/** Brand configuration object consumed by UI, emails, and metadata helpers. */
export interface BrandConfig {
  name: string
  logoUrl?: string
  faviconUrl?: string
  customCssUrl?: string
  supportEmail?: string
  documentationUrl?: string
  termsUrl?: string
  privacyUrl?: string
  theme?: ThemeColors
}

/** Public-facing brand name. */
export const BRAND_NAME = 'CrewMeld'
/** Primary brand domain. */
export const BRAND_DOMAIN = 'crewmeld.io'
/** Support inbox address. */
export const BRAND_SUPPORT_EMAIL = 'contact@crewmeld.ai'
/** Default logo path served from the `public/` directory.
 *  `auth-brand-panel.tsx` applies `brightness-0 invert` to tint dark-colored
 *  logos white on the gradient background, so we point at the dark asset. */
export const BRAND_LOGO_URL = '/logo/crewmeld-text-dark.svg'
/** Default favicon path served from the `public/` directory. */
export const BRAND_FAVICON_URL = '/favicon/favicon.ico'
/** Relative URL to the privacy policy page. */
export const BRAND_PRIVACY_URL = '/privacy'
/** Relative URL to the terms of service page. */
export const BRAND_TERMS_URL = '/terms'
/** Relative URL to the user-facing documentation. */
export const BRAND_DOCUMENTATION_URL = '/docs'

/** Default theme palette; mirrors the legacy `defaultBrandConfig.theme`. */
export const BRAND_THEME: ThemeColors = {
  primaryColor: '#2563EB',
  primaryHoverColor: '#1D4ED8',
  accentColor: '#3B82F6',
  accentHoverColor: '#60A5FA',
  backgroundColor: '#0c0c0c',
}

/**
 * Canonical brand configuration object.
 *
 * Prefer calling `getBrandConfig()` or `useBrandConfig()` — this constant
 * is exported for consumers that need to read the value during module
 * initialization (e.g. build-time helpers).
 */
export const brand: BrandConfig = {
  name: BRAND_NAME,
  logoUrl: BRAND_LOGO_URL,
  faviconUrl: BRAND_FAVICON_URL,
  customCssUrl: undefined,
  supportEmail: BRAND_SUPPORT_EMAIL,
  documentationUrl: BRAND_DOCUMENTATION_URL,
  termsUrl: BRAND_TERMS_URL,
  privacyUrl: BRAND_PRIVACY_URL,
  theme: BRAND_THEME,
}

/**
 * Returns the brand configuration.
 *
 * Kept as a function for API compatibility with the legacy
 * `@/ee/whitelabeling` module, which read environment variables at runtime.
 */
export function getBrandConfig(): BrandConfig {
  return brand
}

/**
 * React hook returning the brand configuration.
 *
 * Drop-in replacement for the legacy `useBrandConfig` hook. Since the
 * configuration is now static, this simply returns the singleton object
 * without subscribing to any React state.
 */
export function useBrandConfig(): BrandConfig {
  return getBrandConfig()
}

/**
 * Generates a `:root { ... }` CSS block that sets CSS custom properties
 * for the active brand theme.
 *
 * The legacy implementation read `NEXT_PUBLIC_BRAND_*` env vars at render
 * time and emitted variables only when explicitly set. Since CrewMeld's
 * build bakes in a fixed theme, the returned CSS is empty by default —
 * all theme tokens live in `globals.css`. An empty string is a safe
 * output for the consumer (the layout inserts it inside a `<style>` tag).
 */
export function generateThemeCSS(): string {
  return ''
}

/**
 * Resolves the public base URL used in metadata. Falls back to
 * `NEXT_PUBLIC_APP_URL` (inlined at build time by Next.js), then to a
 * sensible localhost default. Never throws — metadata generation must
 * remain safe during build/static analysis.
 */
function resolveBaseUrl(): string {
  const raw = (process.env.NEXT_PUBLIC_APP_URL ?? '').trim()
  if (!raw) {
    return 'http://localhost:6100'
  }
  if (/^https?:\/\//i.test(raw)) {
    return raw
  }
  const protocol = process.env.NODE_ENV === 'production' ? 'https://' : 'http://'
  return `${protocol}${raw}`
}

/**
 * Generates Next.js `Metadata` for the root layout, including Open Graph,
 * Twitter cards, favicon links, and app-manifest wiring.
 *
 * Callers may pass a partial `Metadata` override to replace any top-level
 * field on a per-page basis.
 */
export function generateBrandedMetadata(override: Partial<Metadata> = {}): Metadata {
  const cfg = getBrandConfig()
  const baseUrl = resolveBaseUrl()

  const defaultTitle = cfg.name
  const summaryFull =
    'CrewMeld is an AI agent workflow builder for enterprises. Build and deploy agentic workflows with a visual canvas, connect to 100+ apps, and leverage domestic LLMs. Enterprise-grade security for AI automation.'
  const summaryShort =
    'CrewMeld is an AI agent workflow builder for enterprise production workflows.'

  return {
    title: {
      template: `%s | ${cfg.name}`,
      default: defaultTitle,
    },
    description: summaryShort,
    applicationName: cfg.name,
    authors: [{ name: cfg.name }],
    generator: 'Next.js',
    keywords: [
      'AI agent',
      'AI agent builder',
      'AI agent workflow',
      'AI workflow automation',
      'visual workflow editor',
      'AI agents',
      'workflow canvas',
      'intelligent automation',
      'AI tools',
      'workflow designer',
      'artificial intelligence',
      'business automation',
      'AI agent workflows',
      'visual programming',
    ],
    referrer: 'origin-when-cross-origin',
    creator: cfg.name,
    publisher: cfg.name,
    metadataBase: new URL(baseUrl),
    alternates: {
      canonical: '/',
      languages: {
        'en-US': '/',
      },
    },
    robots: {
      index: true,
      follow: true,
      googleBot: {
        index: true,
        follow: true,
        'max-image-preview': 'large',
        'max-video-preview': -1,
        'max-snippet': -1,
      },
    },
    openGraph: {
      type: 'website',
      locale: 'en_US',
      url: baseUrl,
      title: defaultTitle,
      description: summaryFull,
      siteName: cfg.name,
      images: [
        {
          url: cfg.logoUrl || '/logo/426-240/primary/small.png',
          width: 2130,
          height: 1200,
          alt: cfg.name,
        },
      ],
    },
    twitter: {
      card: 'summary_large_image',
      title: defaultTitle,
      description: summaryFull,
      images: [cfg.logoUrl || '/logo/426-240/primary/small.png'],
      creator: '@crewmeld_ai',
      site: '@crewmeld_ai',
    },
    manifest: '/manifest.webmanifest',
    icons: {
      icon: [
        { url: '/favicon/favicon-16x16.png', sizes: '16x16', type: 'image/png' },
        { url: '/favicon/favicon-32x32.png', sizes: '32x32', type: 'image/png' },
        {
          url: '/favicon/favicon-192x192.png',
          sizes: '192x192',
          type: 'image/png',
        },
        {
          url: '/favicon/favicon-512x512.png',
          sizes: '512x512',
          type: 'image/png',
        },
        { url: cfg.faviconUrl || '/favicon/favicon.ico', sizes: 'any', type: 'image/png' },
      ],
      apple: '/favicon/apple-touch-icon.png',
      shortcut: cfg.faviconUrl || '/favicon/favicon.ico',
    },
    appleWebApp: {
      capable: true,
      statusBarStyle: 'default',
      title: cfg.name,
    },
    formatDetection: {
      telephone: false,
    },
    category: 'technology',
    other: {
      'apple-mobile-web-app-capable': 'yes',
      'mobile-web-app-capable': 'yes',
      'msapplication-TileColor': '#701FFC',
      'msapplication-config': '/favicon/browserconfig.xml',
    },
    ...override,
  }
}

/**
 * Generates a schema.org `SoftwareApplication` document used for SEO
 * structured data.
 */
export function generateStructuredData() {
  const baseUrl = resolveBaseUrl()
  return {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: BRAND_NAME,
    description:
      'CrewMeld is an AI agent workflow builder for enterprises. Build and deploy agentic workflows with a visual canvas, connect to 100+ apps, and leverage domestic LLMs. Enterprise-grade security for AI automation.',
    url: baseUrl,
    applicationCategory: 'BusinessApplication',
    operatingSystem: 'Web Browser',
    applicationSubCategory: 'AIWorkflowAutomation',
    areaServed: 'Worldwide',
    availableLanguage: ['en', 'zh-CN'],
    offers: {
      '@type': 'Offer',
      category: 'SaaS',
    },
    creator: {
      '@type': 'Organization',
      name: BRAND_NAME,
      url: baseUrl,
    },
    featureList: [
      'Visual AI Agent Builder',
      'Workflow Canvas Interface',
      'AI Agent Automation',
      'Custom AI Workflows',
    ],
  }
}
