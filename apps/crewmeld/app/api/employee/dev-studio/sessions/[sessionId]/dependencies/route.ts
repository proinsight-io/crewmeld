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
import { getCurrentUserRole } from '@/lib/auth/rbac/check-role'
import { normalizeName, parseSpec } from '@/lib/dev-studio/dependency-spec'
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
  globals: string[]
  needsReview: boolean
}

const EMPTY: DependencyReviewPayload = {
  libraries: [],
  pendingLibraries: [],
  domains: [],
  globals: [],
  needsReview: false,
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

  const settings = await getSandboxSettings()
  const approved = session.approvedDependencies
  // Libraries covered by a global preset (by normalized name) are admin-blessed
  // and never gate adopt — exclude them from the pending set (Model A′).
  const presetNames = new Set(settings.presetPythonPackages.map(normalizeName))
  const pendingLibraries = manifest.dependencies.libraries.filter(
    (l) => !approved.libraries.includes(l) && !presetNames.has(normalizeName(l))
  )
  const pendingDomains = manifest.dependencies.domains.filter((d) => !approved.domains.includes(d))

  const payload: DependencyReviewPayload = {
    libraries: manifest.dependencies.libraries.map((raw) => ({ ...parseSpec(raw), raw })),
    pendingLibraries: pendingLibraries.map((raw) => ({ ...parseSpec(raw), raw })),
    domains: manifest.dependencies.domains,
    globals: settings.presetPythonPackages,
    needsReview: pendingLibraries.length > 0 || pendingDomains.length > 0,
  }
  return Response.json(payload)
}
