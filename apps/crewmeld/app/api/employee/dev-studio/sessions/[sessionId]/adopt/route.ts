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
import {
  type AdoptProgressEvent,
  encodeSseEvent,
} from '@/lib/dev-studio/adopt-progress'
import { AdoptError } from '@/lib/dev-studio/dependency-prewarmer'
import { getDevStudioEnv } from '@/lib/dev-studio/env'
import { OpenSandboxClient } from '@/lib/dev-studio/opensandbox-client'
import { sessionStore } from '@/lib/dev-studio/session-store'

const logger = createLogger('adopt-route')

interface RouteContext {
  params: Promise<{ sessionId: string }>
}

async function destroyContainerBestEffort(
  activeContainerId: string | null,
  sessionId: string,
): Promise<void> {
  if (!activeContainerId) return

  const env = getDevStudioEnv()
  const client = new OpenSandboxClient({
    serverUrl: env.OPENSANDBOX_SERVER_URL,
    apiKey: env.OPENSANDBOX_API_KEY,
    useProxy: env.OPENSANDBOX_USE_PROXY,
  })
  await client.destroy(activeContainerId).catch((err) => {
    logger.warn('container destroy failed (TTL backstop)', { sessionId, err })
  })
}

function toProgressError(err: unknown): Extract<AdoptProgressEvent, { type: 'error' }> {
  if (err instanceof AdoptError) {
    return { type: 'error', message: err.detail, retryable: err.retryable }
  }
  return { type: 'error', message: 'Adopt failed', retryable: true }
}

export async function PATCH(req: Request, ctx: RouteContext): Promise<Response> {
  const { sessionId } = await ctx.params
  const auth = await getCurrentUserRole()
  if (!auth.authenticated || !auth.userId) {
    return new Response('Unauthorized', { status: 401 })
  }
  const userId = auth.userId

  const session = await sessionStore.get(sessionId)
  if (!session || session.userId !== userId) {
    return new Response('Not Found', { status: 404 })
  }

  if (session.status === 'adopted') {
    return Response.json(
      { error: 'conflict', detail: 'Session already adopted', retryable: false },
      { status: 409 }
    )
  }

  if (req.headers.get('accept')?.includes('text/event-stream')) {
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const emit = (event: AdoptProgressEvent) => controller.enqueue(encodeSseEvent(event))
        try {
          const result = await adoptSession(sessionId, userId, emit)
          emit({ type: 'progress', step: 'closing' })
          await destroyContainerBestEffort(session.activeContainerId, sessionId)
          emit({ type: 'complete', ...result })
        } catch (err) {
          logger.warn('streamed adopt failed', { sessionId, err })
          emit(toProgressError(err))
        } finally {
          controller.close()
        }
      },
    })

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    })
  }

  try {
    const result = await adoptSession(sessionId, userId)

    // Best-effort container destroy AFTER adopt completes.
    await destroyContainerBestEffort(session.activeContainerId, sessionId)

    return Response.json(result)
  } catch (err) {
    if (err instanceof AdoptError) {
      logger.warn(
        'adopt failed (AdoptError)',
        { sessionId, code: err.code, detail: err.detail, retryable: err.retryable },
      )
      return Response.json(
        { error: err.code, detail: err.detail, retryable: err.retryable },
        { status: err.code === 'session-not-found' ? 404 : 422 }
      )
    }
    logger.error('adopt failed (unhandled)', { sessionId, err })
    throw err
  }
}
