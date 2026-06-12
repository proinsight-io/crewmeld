/**
 * POST /api/employee/tools/api-tool/test-run
 *
 * Ad-hoc test-run for the API-tool editor. Accepts a raw {@link ApiToolSpec}
 * and optional input, runs a static code-safety check on pre/post snippets,
 * then executes the spec via the shared {@link runApiTool} runner.
 *
 * No audit log is written — this is a developer-only editor shortcut, not a
 * production invocation. Permission required: `skill:edit` (same as the
 * generic tool execute endpoint).
 */
import { createLogger } from '@crewmeld/logger'
import type { NextRequest } from 'next/server'
import { apiAuthErr } from '@/lib/api/response'
import { requirePermission } from '@/lib/auth/rbac/check-permission'
import { checkApiToolCode, localizeApiToolError } from '@/lib/tools/api-tool-check'
import { buildApiToolDeps } from '@/lib/tools/api-tool-deps'
import { resolveLocale } from '@/lib/i18n/server-locale'
import { runApiTool } from '@/lib/tools/api-tool-runner'
import type { ApiToolSpec } from '@/lib/tools/api-tool-types'

const logger = createLogger('ApiToolTestRun')

export async function POST(request: NextRequest) {
  // Auth guard — must be first
  const auth = await requirePermission('skill:edit')
  if (!auth.authenticated || auth.error) {
    return apiAuthErr(auth)
  }

  let body: { apiSpec?: ApiToolSpec; input?: unknown }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return Response.json({ success: false, error: 'Invalid JSON body' }, { status: 422 })
  }

  const spec = body.apiSpec
  if (!spec) {
    return Response.json({ success: false, error: 'apiSpec required' }, { status: 422 })
  }

  // Static code-safety check on pre and post snippets before executing. Blank
  // snippets are optional (pre defaults to no transform, post to returning the
  // raw body in the runner), so skip the check for empty stages.
  const locale = resolveLocale(request)
  const stageLabel: Record<'pre' | 'post', string> = {
    pre: locale === 'zh-CN' ? '前处理 (pre)' : 'pre',
    post: locale === 'zh-CN' ? '后处理 (post)' : 'post',
  }
  for (const [stage, code] of [
    ['pre', spec.pre],
    ['post', spec.post],
  ] as const) {
    if (!code || code.trim() === '') continue
    const check = checkApiToolCode(code)
    if (!check.passed) {
      const msg = check.errors.map((e) => localizeApiToolError(e, locale)).join('; ')
      return Response.json(
        { success: false, error: `${stageLabel[stage]}: ${msg}` },
        { status: 422 }
      )
    }
  }

  logger.info('API tool test-run started', { userId: auth.userId! })

  const result = await runApiTool(spec, body.input ?? {}, buildApiToolDeps(), {})

  logger.info('API tool test-run completed', {
    userId: auth.userId!,
    success: result.success,
    stage: result.stage,
  })

  return Response.json(result)
}
