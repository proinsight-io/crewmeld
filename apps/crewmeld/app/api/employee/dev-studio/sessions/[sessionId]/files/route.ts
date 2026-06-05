/**
 * GET /api/employee/dev-studio/sessions/:sessionId/files
 *
 * Returns a recursive snapshot of the session workspace as a `FileNode` tree
 * rooted at the workspace directory inside the sandbox container.
 *
 * The tree is built from the OpenSandbox SDK's `files.search` API (execd
 * surface) — NOT from the BFF host's local filesystem. The legacy host-fs
 * implementation only worked when crewmeld and the sandbox shared a host
 * (k3s in-cluster), and silently returned an empty tree the moment crewmeld
 * ran on a dev workstation outside the cluster. Routing through the SDK
 * means the BFF reads the file list straight out of the sandbox, with the
 * same proxy/direct endpoint resolution as the chat path.
 *
 * Hidden directories (`.crewmeld-studio`, `.git`) are filtered when shaping
 * the tree so AI bookkeeping never leaks to the operator UI.
 *
 * Auth + ownership: cross-user lookups return 404 (not 403) to avoid leaking
 * session existence — matches sibling routes.
 *
 * Errors:
 *  - 401 unauthenticated
 *  - 404 session missing or not owned by caller
 *  - 502 sandbox file API unreachable / errored (retryable)
 *  - empty tree (200) when the session has no active container yet
 */
import { getCurrentUserRole } from '@/lib/auth/rbac/check-role'
import { getDevStudioEnv } from '@/lib/dev-studio/env'
import { buildTreeFromSearchResults, type FlatFileEntry } from '@/lib/dev-studio/file-tree'
import { OpenSandboxClient } from '@/lib/dev-studio/opensandbox-client'
import { sessionStore } from '@/lib/dev-studio/session-store'

interface RouteContext {
  params: Promise<{ sessionId: string }>
}

/** Sandbox-side workspace root. Mirrors the bind mount declared in POST /sessions. */
const WORKSPACE_ROOT = '/root/workspace'

const EMPTY_TREE = {
  name: '',
  path: '',
  type: 'directory' as const,
  children: [],
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

  // No live container → nothing to list. Return an empty tree so the panel
  // renders its "empty" affordance rather than the operator seeing a 502.
  if (!session.activeContainerId) {
    return Response.json({ tree: EMPTY_TREE })
  }

  let env: ReturnType<typeof getDevStudioEnv>
  try {
    env = getDevStudioEnv()
  } catch (e) {
    return new Response(
      JSON.stringify({ error: 'config-missing', detail: String(e), retryable: false }),
      { status: 503, headers: { 'content-type': 'application/json' } }
    )
  }

  const client = new OpenSandboxClient({
    serverUrl: env.OPENSANDBOX_SERVER_URL,
    apiKey: env.OPENSANDBOX_API_KEY,
    useProxy: env.OPENSANDBOX_USE_PROXY,
  })

  let flat: FlatFileEntry[]
  try {
    const files = await client.getFiles(session.activeContainerId)
    // SDK returns absolute-path entries under the requested root, recursively.
    flat = (await files.search({ path: WORKSPACE_ROOT })) as FlatFileEntry[]
  } catch (e) {
    return new Response(
      JSON.stringify({
        error: 'sandbox-files-unreachable',
        detail: String(e),
        retryable: true,
      }),
      { status: 502, headers: { 'content-type': 'application/json' } }
    )
  }

  const tree = buildTreeFromSearchResults(flat, WORKSPACE_ROOT, {
    hiddenPrefixes: ['.crewmeld-studio', '.git'],
  })
  return Response.json({ tree })
}
