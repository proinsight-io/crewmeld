/**
 * GET /api/employee/dev-studio/sessions/:sessionId/dependencies
 *
 * Backs the inline package allow-list review card. Returns the session
 * manifest's declared dependencies (libraries parsed into editable
 * name/version pairs, plus read-only domains), the sandbox preset global
 * Python packages (shown for context — they are auto-folded in on approve),
 * and a `needsReview` flag.
 *
 * `needsReview` is true when the manifest declares any library/domain not yet
 * present in `session.approvedDependencies` — the same diff the notification
 * center uses — so the card and the adopt gate share one signal.
 *
 * Status semantics:
 *  - 401 — unauthenticated
 *  - 404 — session missing or owned by another user
 *  - 200 — payload (empty lists + needsReview=false when no manifest yet)
 */
import fs from 'node:fs/promises'
import { getCurrentUserRole } from '@/lib/auth/rbac/check-role'
import { normalizeName, parseSpec } from '@/lib/dev-studio/dependency-spec'
import { scanEgress } from '@/lib/dev-studio/egress-scanner'
import { safeResolveInSession } from '@/lib/dev-studio/file-tree'
import { readManifestFromSession } from '@/lib/dev-studio/manifest-reader'
import { sessionStore } from '@/lib/dev-studio/session-store'
import { getSandboxSettings } from '@/lib/sandbox/settings'

interface RouteContext {
  params: Promise<{ sessionId: string }>
}

/** A library spec decomposed for the editable review rows. */
interface ReviewLibrary {
  name: string
  version: string
  raw: string
}

interface DependencyReviewPayload {
  /** Full actual dependency list (edited in the test-panel dependency editor). */
  libraries: ReviewLibrary[]
  /** Subset needing approval: declared libs minus global presets minus approved. */
  pendingLibraries: ReviewLibrary[]
  domains: string[]
  ips: string[]
  globals: string[]
  needsReview: boolean
  /** Domains discovered by scanning workspace source (may include manifest ones). */
  scannedDomains: string[]
  /** IPs discovered by scanning workspace source. */
  scannedIps: string[]
}

const EMPTY: DependencyReviewPayload = {
  libraries: [],
  pendingLibraries: [],
  domains: [],
  ips: [],
  globals: [],
  needsReview: false,
  scannedDomains: [],
  scannedIps: [],
}

export async function GET(_req: Request, ctx: RouteContext): Promise<Response> {
  const { sessionId } = await ctx.params

  const auth = await getCurrentUserRole()
  if (!auth.authenticated || !auth.userId) {
    return new Response('Unauthorized', { status: 401 })
  }

  const session = await sessionStore.get(sessionId)
  if (!session || session.userId !== auth.userId) {
    return new Response('Not Found', { status: 404 })
  }

  const manifest = await readManifestFromSession(sessionId).catch(() => null)
  if (!manifest) {
    return Response.json(EMPTY)
  }

  // Static scan of the tool's own source files for external egress targets the
  // AI may have omitted from the manifest. Text files only; per-file failures
  // are swallowed so a single unreadable/binary entry never fails the review.
  const sources: string[] = []
  for (const rel of manifest.files) {
    if (rel === 'requirements.txt') continue
    const abs = safeResolveInSession(sessionId, rel)
    if (!abs) continue
    try {
      sources.push(await fs.readFile(abs, 'utf-8'))
    } catch {
      // ignore unreadable / binary / missing file
    }
  }
  const scanned = scanEgress(sources)

  const unionDomains = [...new Set([...manifest.dependencies.domains, ...scanned.domains])]
  const unionIps = [...new Set([...manifest.dependencies.ips, ...scanned.ips])]

  const settings = await getSandboxSettings()
  const approved = session.approvedDependencies
  // Libraries covered by a global preset (by normalized name) are admin-blessed
  // and never gate adopt — exclude them from the pending set (Model A′).
  const presetNames = new Set(settings.presetPythonPackages.map(normalizeName))
  const pendingLibraries = manifest.dependencies.libraries.filter(
    (l) => !approved.libraries.includes(l) && !presetNames.has(normalizeName(l))
  )
  const rejectedDomains = approved.rejectedDomains ?? []
  const rejectedIps = approved.rejectedIps ?? []
  const pendingDomains = unionDomains.filter(
    (d) => !approved.domains.includes(d) && !rejectedDomains.includes(d)
  )
  const pendingIps = unionIps.filter(
    (ip) => !(approved.ips ?? []).includes(ip) && !rejectedIps.includes(ip)
  )

  const payload: DependencyReviewPayload = {
    libraries: manifest.dependencies.libraries.map((raw) => ({ ...parseSpec(raw), raw })),
    pendingLibraries: pendingLibraries.map((raw) => ({ ...parseSpec(raw), raw })),
    domains: unionDomains,
    ips: unionIps,
    globals: settings.presetPythonPackages,
    needsReview: pendingLibraries.length > 0 || pendingDomains.length > 0 || pendingIps.length > 0,
    scannedDomains: scanned.domains,
    scannedIps: scanned.ips,
  }
  return Response.json(payload)
}
