/**
 * GET /api/employee/tool-execution/[execId]/files/[...path]
 *
 * Stream a tool-execution IO file back to the caller. Path is a catch-all so
 * nested layouts (`/files/sub/dir/foo.png`) work. Single-segment downloads
 * (`/files/output.png`) are served by the sibling `[filename]/route.ts` so
 * they don't 405 on Next.js' single-segment-wins routing precedence.
 *
 * All download logic — auth, NFS-aware retry, Range, MIME — lives in
 * {@link serveToolExecutionFile}; both routes call it.
 *
 * Status codes (from the shared helper):
 *   - 200 — full body
 *   - 206 — partial body for Range
 *   - 400 — path traversal attempt
 *   - 401 — unauthenticated
 *   - 403 — execId not owned by caller
 *   - 404 — file missing (after retry)
 *   - 416 — invalid / unsatisfiable Range
 */
import type { NextRequest } from 'next/server'
import { serveToolExecutionFile } from '@/lib/dev-studio/tool-execution-download'

interface RouteContext {
  params: Promise<{ execId: string; path: string[] }>
}

export async function GET(req: NextRequest, ctx: RouteContext): Promise<Response> {
  const { execId, path: segments } = await ctx.params
  return serveToolExecutionFile(req, execId, segments ?? [])
}
