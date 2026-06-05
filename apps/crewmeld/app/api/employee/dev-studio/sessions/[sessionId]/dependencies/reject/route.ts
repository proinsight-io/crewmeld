/**
 * POST /api/employee/dev-studio/sessions/:sessionId/dependencies/reject
 *
 * Surfaces the operator's rejection back to the AI as an in-band system note
 * drained on the next /chat turn. The note lists the rejected libraries /
 * domains plus an optional free-form reason. Phrasing is locale-routed so it
 * matches the language of the AI persona prompt.
 *
 * Rejection does NOT modify the manifest or `approvedDependencies` — it is a
 * one-shot signal to the AI to rewrite without those packages. Editing the
 * actual dependency list is done in the test-panel dependency editor. When the
 * AI rewrites, the new manifest re-triggers the review signal as needed.
 *
 * Status semantics:
 *  - 401 — unauthenticated
 *  - 404 — session missing or owned by another user
 *  - 400 — bad body shape OR both arrays empty (nothing to reject)
 *  - 204 — note queued
 */
import { z } from 'zod'
import { getCurrentUserRole } from '@/lib/auth/rbac/check-role'
import { sessionStore } from '@/lib/dev-studio/session-store'
import { resolveLocale } from '@/lib/i18n/server-locale'
import { messages as locales } from '@/locales'

interface RouteContext {
  params: Promise<{ sessionId: string }>
}

const RejectSchema = z
  .object({
    libraries: z.array(z.string()).optional(),
    domains: z.array(z.string()).optional(),
    note: z.string().max(500).optional(),
  })
  .strict()

type RejectInject = (typeof locales)[keyof typeof locales]['devStudio']['inject']

/** Format the rejection list and optional note as a single instruction line. */
function formatNote(
  inject: RejectInject,
  libraries: string[],
  domains: string[],
  note?: string
): string {
  const items = [
    ...libraries.map((l) => `${inject.depsRejectedLibLabel}${l}`),
    ...domains.map((d) => `${inject.depsRejectedDomLabel}${d}`),
  ].join(inject.depsRejectedItemSep)
  const reason = note ? `${inject.depsRejectedReasonPrefix}${note}` : ''
  return inject.depsRejectedPrompt.replace('{items}', items).replace('{reason}', reason)
}

export async function POST(req: Request, ctx: RouteContext): Promise<Response> {
  const { sessionId } = await ctx.params

  const auth = await getCurrentUserRole()
  if (!auth.authenticated || !auth.userId) {
    return new Response('Unauthorized', { status: 401 })
  }

  const session = await sessionStore.get(sessionId)
  if (!session || session.userId !== auth.userId) {
    return new Response('Not Found', { status: 404 })
  }

  const raw = await req.json().catch(() => null)
  const parsed = RejectSchema.safeParse(raw)
  if (!parsed.success) {
    return new Response(
      JSON.stringify({ error: 'bad-request', detail: parsed.error.message, retryable: false }),
      { status: 400, headers: { 'content-type': 'application/json' } }
    )
  }

  const libraries = parsed.data.libraries ?? []
  const domains = parsed.data.domains ?? []
  if (libraries.length === 0 && domains.length === 0) {
    return new Response(
      JSON.stringify({
        error: 'nothing-to-reject',
        detail: 'At least one library or domain must be supplied.',
        retryable: false,
      }),
      { status: 400, headers: { 'content-type': 'application/json' } }
    )
  }

  const inject = locales[resolveLocale(req)].devStudio.inject
  const message = formatNote(inject, libraries, domains, parsed.data.note)
  sessionStore.queueSystemNote(sessionId, message)
  return new Response(null, { status: 204 })
}
