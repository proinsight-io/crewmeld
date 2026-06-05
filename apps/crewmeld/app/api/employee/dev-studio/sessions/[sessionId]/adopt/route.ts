/**
 * PATCH /api/employee/dev-studio/sessions/:sessionId/adopt
 *
 * Promotes a session to `status='adopted'` by running the full adopt pipeline
 * (spec §10.1): read manifest → sync workspace to NFS code dir → prewarm pip
 * deps → upsert tool record → create/refresh default instance → mark session
 * adopted. The active container is destroyed best-effort AFTER the pipeline
 * completes (TTL is the backstop).
 *
 * Returns `{ toolId, toolName, isUpdate, needsRedeploy }` on success.
 * Returns 404 when the session is missing (`session-not-found`).
 * Returns 409 when the session is already adopted.
 * Returns 422 with `{ error, detail, retryable }` for structured
 * {@link AdoptError} failures (manifest-missing,
 * dependency-install-failed). Other errors bubble up
 * to the framework as 500.
 */

import { createLogger } from '@crewmeld/logger'
import { getCurrentUserRole } from '@/lib/auth/rbac/check-role'
import { adoptSession } from '@/lib/dev-studio/adopt-handler'
import { AdoptError } from '@/lib/dev-studio/dependency-prewarmer'
import { getDevStudioEnv } from '@/lib/dev-studio/env'
import { OpenSandboxClient } from '@/lib/dev-studio/opensandbox-client'
import { sessionStore } from '@/lib/dev-studio/session-store'

const logger = createLogger('adopt-route')

interface RouteContext {
  params: Promise<{ sessionId: string }>
}

export async function PATCH(_req: Request, ctx: RouteContext): Promise<Response> {
  const { sessionId } = await ctx.params
  const auth = await getCurrentUserRole()
  if (!auth.authenticated || !auth.userId) {
    return new Response('Unauthorized', { status: 401 })
  }

  const session = await sessionStore.get(sessionId)
  if (!session || session.userId !== auth.userId) {
    return new Response('Not Found', { status: 404 })
  }

  if (session.status === 'adopted') {
    return Response.json(
      { error: 'conflict', detail: 'Session already adopted', retryable: false },
      { status: 409 }
    )
  }

  try {
    const result = await adoptSession(sessionId, auth.userId)

    // Best-effort container destroy AFTER adopt completes.
    if (session.activeContainerId) {
      const env = getDevStudioEnv()
      const client = new OpenSandboxClient({
        serverUrl: env.OPENSANDBOX_SERVER_URL,
        apiKey: env.OPENSANDBOX_API_KEY,
        useProxy: env.OPENSANDBOX_USE_PROXY,
      })
      await client.destroy(session.activeContainerId).catch((err) => {
        logger.warn({ sessionId, err }, 'container destroy failed (TTL backstop)')
      })
    }

    return Response.json(result)
  } catch (err) {
    if (err instanceof AdoptError) {
      logger.warn(
        { sessionId, code: err.code, detail: err.detail, retryable: err.retryable },
        'adopt failed (AdoptError)'
      )
      return Response.json(
        { error: err.code, detail: err.detail, retryable: err.retryable },
        { status: err.code === 'session-not-found' ? 404 : 422 }
      )
    }
    logger.error({ sessionId, err }, 'adopt failed (unhandled)')
    throw err
  }
}
