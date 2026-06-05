import { createLogger } from '@crewmeld/logger'

const logger = createLogger('instrumentation')

/**
 * Next.js instrumentation hook — executed once per server runtime on startup.
 *
 * When `E2E_MOCK_SERVER=1` and running in the Node.js runtime (not Edge),
 * this starts the MSW server that intercepts outbound BFF HTTP requests to
 * LLM providers and RAGFlow during Playwright E2E tests.
 *
 * Guard conditions:
 * - `E2E_MOCK_SERVER === '1'`   — opt-in env var; never active in production
 * - `NEXT_RUNTIME === 'nodejs'` — MSW node server requires Node.js; Edge is excluded
 *
 * The dynamic `import()` keeps MSW out of the production bundle entirely.
 *
 * @see https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */
export async function register(): Promise<void> {
  // Diagnostic: log env at instrumentation time (safe — no secrets logged)
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // biome-ignore lint/suspicious/noConsole: instrumentation diagnostic
    console.log(
      '[instrumentation] E2E_MOCK_SERVER =',
      process.env.E2E_MOCK_SERVER,
      'NEXT_RUNTIME =',
      process.env.NEXT_RUNTIME
    )
  }
  if (process.env.E2E_MOCK_SERVER === '1' && process.env.NEXT_RUNTIME === 'nodejs') {
    // biome-ignore lint/suspicious/noConsole: instrumentation startup log
    console.log('[instrumentation] Starting MSW server-side mock layer...')
    const { startMockServer } = await import('../../tests/e2e/fixtures/server-mocks/server')
    startMockServer()
    // biome-ignore lint/suspicious/noConsole: instrumentation startup log
    console.log('[instrumentation] MSW server listening.')
  }

  // Dev Studio: fail-fast on startup if env is misconfigured.
  // Only validate when DEV_STUDIO_ENABLED=1 to keep existing deployments unaffected.
  if (process.env.NEXT_RUNTIME === 'nodejs' && process.env.DEV_STUDIO_ENABLED === '1') {
    // Dynamic imports for Node-only modules so the Edge runtime bundle is clean.
    const fs = await import('node:fs/promises')
    const path = await import('node:path')

    let envOk = false
    try {
      const { getDevStudioEnv } = await import('./lib/dev-studio/env')
      getDevStudioEnv()
      envOk = true
      // biome-ignore lint/suspicious/noConsole: instrumentation startup log
      console.log('[instrumentation] Dev Studio env OK.')
    } catch (e) {
      // biome-ignore lint/suspicious/noConsole: instrumentation diagnostic
      console.error('[instrumentation]', e instanceof Error ? e.message : String(e))
      throw e // refuse to start with bad config
    }

    // NFS volume root validation — fail-fast on misconfiguration.
    // See spec docs/superpowers/specs/2026-05-28-cross-platform-nfs-volume-design.md §12.5
    const bffRoot = process.env.CREWMELD_BFF_VOLUME_ROOT
    if (!bffRoot) {
      throw new Error(
        'CREWMELD_BFF_VOLUME_ROOT not configured. See README "NFS 配置" section.'
      )
    }

    try {
      await fs.access(bffRoot, fs.constants.R_OK | fs.constants.W_OK)
    } catch {
      throw new Error(
        `CREWMELD_BFF_VOLUME_ROOT not readable/writable: ${bffRoot}. ` +
          `Did you mount the NFS share? See README "NFS 配置" section.`
      )
    }

    const testFile = path.join(bffRoot, '.crewmeld-write-test')
    try {
      await fs.writeFile(testFile, String(Date.now()))
      await fs.unlink(testFile)
    } catch (err) {
      throw new Error(
        `CREWMELD_BFF_VOLUME_ROOT write-test failed: ${bffRoot}. ` +
          `Underlying error: ${(err as Error).message}`
      )
    }

    // Pre-create top-level shared-volume directories (idempotent).
    await fs.mkdir(path.join(bffRoot, 'sessions'), { recursive: true })
    await fs.mkdir(path.join(bffRoot, 'tools-workspace', 'io'), { recursive: true })
    await fs.mkdir(path.join(bffRoot, 'shared-libs', 'site-packages'), { recursive: true })

    // Startup banner so ops can quickly confirm cross-platform NFS layout.
    // sameHost=true indicates BFF and sandbox share the same physical path
    // (typical for Linux single-host or in-cluster K8s); false implies a
    // cross-platform NFS mount (e.g. Windows BFF + Ubuntu sandbox).
    logger.info('NFS volume roots validated', {
      bffRoot: process.env.CREWMELD_BFF_VOLUME_ROOT,
      sandboxRoot: process.env.CREWMELD_SANDBOX_VOLUME_ROOT,
      sameHost:
        process.env.CREWMELD_BFF_VOLUME_ROOT === process.env.CREWMELD_SANDBOX_VOLUME_ROOT,
    })

    // Warn on deprecated env vars (will be removed in later tasks).
    const deprecated = [
      'CREWMELD_SESSIONS_DIR',
      'CREWMELD_TOOLS_WORKSPACE_DIR',
      'CREWMELD_SHARED_LIBS_DIR',
      'CREWMELD_DEPLOY_LOCAL',
    ] as const
    for (const key of deprecated) {
      if (process.env[key]) {
        logger.warn(
          'Deprecated env variable detected; ignored. ' +
            'See spec 2026-05-28-cross-platform-nfs-volume-design.md §5.2',
          { env: key }
        )
      }
    }

    // One-shot A.min → B host layout migration. Non-fatal: a migration
    // failure must not block BFF startup. The migration now derives its
    // root from the paths facade (BFF_VOLUME_ROOT/sessions), so no env-
    // sourced root is threaded through.
    if (envOk) {
      try {
        const { migrateAMinHostDirs } = await import('./lib/dev-studio/host-migration')
        const result = await migrateAMinHostDirs()
        if (result.migrated.length > 0) {
          // biome-ignore lint/suspicious/noConsole: instrumentation startup log
          console.log(
            `[instrumentation] dev-studio host migration: migrated ${result.migrated.length} session(s) ` +
              `to B layout: ${result.migrated.join(', ')}`
          )
        }
        if (result.errors.length > 0) {
          for (const { sessionId, error } of result.errors) {
            // biome-ignore lint/suspicious/noConsole: instrumentation diagnostic
            console.warn(
              `[instrumentation] dev-studio host migration failed for session ${sessionId}:`,
              error.stack ?? error.message
            )
          }
        }
      } catch (e) {
        // biome-ignore lint/suspicious/noConsole: instrumentation diagnostic
        console.error(
          '[instrumentation] dev-studio host migration crashed:',
          e instanceof Error ? (e.stack ?? e.message) : String(e)
        )
      }
    }
  }

  // Sweep orphan sandbox NetworkPolicies (left over from previous server
  // process crashes). One-shot at startup; failures are non-fatal.
  if (
    process.env.NEXT_RUNTIME === 'nodejs' &&
    process.env.K8S_API_SERVER &&
    process.env.K8S_API_TOKEN
  ) {
    try {
      const { reconcileOrphanNetworkPolicies } = await import('./lib/sandbox/network-policy')
      const result = await reconcileOrphanNetworkPolicies()
      if (result.scanned > 0) {
        // biome-ignore lint/suspicious/noConsole: instrumentation startup log
        console.log(
          `[instrumentation] Sandbox NP reconcile: scanned=${result.scanned} deleted=${result.deleted}`
        )
      }
    } catch (err) {
      // biome-ignore lint/suspicious/noConsole: instrumentation diagnostic
      console.warn(
        '[instrumentation] Sandbox NP reconcile failed:',
        err instanceof Error ? err.message : String(err)
      )
    }
  }

  // Schedule recurring cleanup of stale SOP workspaces in MinIO (default
  // 30-day retention). Runs once immediately, then on a 24h interval.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    try {
      const { startSopWorkspaceCleanupCron } = await import(
        './lib/sop/workspace-cleanup-cron'
      )
      startSopWorkspaceCleanupCron()
    } catch (err) {
      // biome-ignore lint/suspicious/noConsole: instrumentation diagnostic
      console.warn(
        '[instrumentation] SOP workspace cleanup cron init failed:',
        err instanceof Error ? err.message : String(err)
      )
    }
  }
}
