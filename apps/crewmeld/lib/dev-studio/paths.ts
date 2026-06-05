/**
 * Shared volume path facade.
 *
 * Centralizes all cross-platform path derivation for NFS-shared directories.
 * BFF callers use forBff() to read/write files via local filesystem (NFS client mount).
 * Sandbox createSandbox callers use forSandbox() to declare hostPath volumes
 * (always Linux-style since OpenSandbox runs on Ubuntu).
 *
 * Both forms point to the same physical NFS data but with different path prefixes
 * depending on the platform mounting the share.
 */
import path from 'node:path'

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

function readRoot(envKey: string): string {
  const raw = process.env[envKey]
  if (!raw || raw.trim().length === 0) {
    throw new Error(`paths.ts: ${envKey} not configured`)
  }
  return raw.replace(/[/\\]+$/, '')
}

function bffJoin(...parts: string[]): string {
  return path.join(readRoot('CREWMELD_BFF_VOLUME_ROOT'), ...parts)
}

function sbxJoin(...parts: string[]): string {
  return `${readRoot('CREWMELD_SANDBOX_VOLUME_ROOT')}/${parts.join('/')}`
}

function assertId(label: string, value: string): void {
  if (!ID_PATTERN.test(value)) {
    throw new Error(`paths.ts: invalid ${label}: ${JSON.stringify(value)}`)
  }
}

function parseDateLayer(execId: string): [string, string, string] {
  const m = execId.match(/^[a-z]+_(\d{4})(\d{2})(\d{2})_/)
  if (!m) {
    throw new Error(`paths.ts: cannot parse date layer from execId: ${execId}`)
  }
  return [m[1], m[2], m[3]]
}

/**
 * Format a Date (or ISO-like string) as `[YYYY, MM, DD]` using UTC components
 * so the same row produces the same path regardless of which machine reads it.
 * Used as the date layer for {@link paths.sessionIo}.
 */
function dateLayerFromDate(d: Date | string): [string, string, string] {
  const date = d instanceof Date ? d : new Date(d)
  if (Number.isNaN(date.getTime())) {
    throw new Error(`paths.ts: invalid date for sessionIo layer: ${String(d)}`)
  }
  const y = String(date.getUTCFullYear())
  const m = String(date.getUTCMonth() + 1).padStart(2, '0')
  const day = String(date.getUTCDate()).padStart(2, '0')
  return [y, m, day]
}

export const paths = {
  /**
   * Root directory containing all per-session subdirectories on the BFF
   * filesystem (NFS-shared volume root + `sessions/`). Exposed for the
   * one-shot host-migration (Task 18) that needs to enumerate every legacy
   * session under this root — application code that targets a specific
   * session should use {@link sessionWorkspace} / {@link sessionClaude}.
   */
  bffSessionsRoot: (): string => bffJoin('sessions'),

  sessionWorkspace: {
    forBff: (sessionId: string): string => {
      assertId('sessionId', sessionId)
      return bffJoin('sessions', sessionId, 'workspace')
    },
    forSandbox: (sessionId: string): string => {
      assertId('sessionId', sessionId)
      return sbxJoin('sessions', sessionId, 'workspace')
    },
  },

  sessionClaude: {
    forBff: (sessionId: string): string => {
      assertId('sessionId', sessionId)
      return bffJoin('sessions', sessionId, 'claude')
    },
    forSandbox: (sessionId: string): string => {
      assertId('sessionId', sessionId)
      return sbxJoin('sessions', sessionId, 'claude')
    },
  },

  toolCode: {
    forBff: (toolId: string): string => {
      assertId('toolId', toolId)
      return bffJoin('tools-workspace', toolId, 'code')
    },
    forSandbox: (toolId: string): string => {
      assertId('toolId', toolId)
      return sbxJoin('tools-workspace', toolId, 'code')
    },
  },

  toolIo: {
    forBff: (execId: string): string => {
      assertId('execId', execId)
      const [y, m, d] = parseDateLayer(execId)
      return bffJoin('tools-workspace', 'io', y, m, d, execId)
    },
    forSandbox: (execId: string): string => {
      assertId('execId', execId)
      const [y, m, d] = parseDateLayer(execId)
      return sbxJoin('tools-workspace', 'io', y, m, d, execId)
    },
  },

  /**
   * SOP-scoped file workspace — unified file IO storage across dev-studio
   * test and production SOP execution.
   *
   * Layout: `<volume-root>/sop-files/<Y>/<M>/<D>/<sopExecId>/<filename>`
   *
   * **Single contract everywhere**:
   *   - dev-studio test: sopExecId == the run-test executionId; BFF seeds the
   *     session io files into this directory; sandbox mounts the *root*
   *     (`<volume>/sop-files/`) to /root/io; the tool reads / writes at
   *     `/root/io/<sopExecId>/<filename>`.
   *   - production SOP: sopExecId == the SOP execution id; BFF seeds the
   *     conversation upload files into this directory at SOP start; same
   *     mount pattern; same tool contract.
   *
   * The mount root is shared across the sandbox lifetime so multiple tool
   * calls within one SOP see each other's outputs in
   * `/root/io/<sopExecId>/`; cross-SOP isolation is enforced via the
   * sopExecId path segment (BFF only ever creates / cleans the matching
   * subdir).
   *
   * Three surfaces:
   *   - `forBff(sopExecId)` — the per-SOP subdir on the BFF filesystem;
   *                          BFF reads/writes here.
   *   - `forSandbox()`      — the **root** (no id, no date), used as the
   *                          sandbox hostPath. The per-SOP subdir is
   *                          reached inside the pod via
   *                          `/root/io/<_sopFileDir>/<filename>` — the
   *                          {@link relPath} value is injected into the
   *                          request body / stdin by the invoker.
   *   - `relPath(sopExecId)` — POSIX-style relative path **from the sandbox
   *                          mount root** to the per-SOP subdir
   *                          (e.g. `2026/06/01/sop_20260601_xxx`). The
   *                          invoker ships this as `_sopFileDir` so tool
   *                          code can `f"/root/io/{_sopFileDir}/{filename}"`
   *                          without ever computing the date itself.
   *
   * Date layer (`Y/M/D/`) is kept so ops can `rm -rf sop-files/2026/05/*`
   * by date. Without `relPath` the tool would need to parse the date out
   * of the sopExecId prefix at runtime; with it the BFF computes once and
   * tools stay date-agnostic.
   */
  sopFiles: {
    forBff: (sopExecId: string): string => {
      assertId('sopExecId', sopExecId)
      const [y, m, d] = parseDateLayer(sopExecId)
      return bffJoin('sop-files', y, m, d, sopExecId)
    },
    forSandbox: (): string => {
      return sbxJoin('sop-files')
    },
    /**
     * Relative POSIX path from `<sop-files root>` to the per-SOP subdir.
     * Always slash-separated (the sandbox is Linux) so callers can use it
     * verbatim as `/root/io/<relPath>/<filename>`.
     */
    relPath: (sopExecId: string): string => {
      assertId('sopExecId', sopExecId)
      const [y, m, d] = parseDateLayer(sopExecId)
      return `${y}/${m}/${d}/${sopExecId}`
    },
  },

  /**
   * Per-session user-uploaded test files. Lives outside `sessions/<sid>/`
   * so it can be bulk-archived / cleaned by date independently of the
   * workspace + claude state, and so all sessions created on the same day
   * share one parent directory for ops convenience.
   *
   * The date layer is fixed at session creation time (caller passes the
   * session row's `createdAt`); a long-lived session that spans a UTC day
   * boundary therefore keeps all its files in one directory.
   *
   * Only `forBff` is exposed: this directory is never mounted into a sandbox
   * directly — sandbox-loader copies its contents into the per-execution
   * toolIo before each run, and the sandbox sees them at `/root/io`.
   */
  sessionIo: {
    forBff: (sessionId: string, createdAt: Date | string): string => {
      assertId('sessionId', sessionId)
      const [y, m, d] = dateLayerFromDate(createdAt)
      return bffJoin('io', 'session', y, m, d, sessionId)
    },
  },

  /**
   * Per-conversation user-uploaded files staged before an SOP runs.
   *
   * Symmetric to {@link sessionIo}: same role in the production SOP flow
   * that `sessionIo` plays in the dev-studio test flow. Files land here
   * when the user uploads through the chat UI (dual-write alongside the
   * legacy MinIO path, see {@link uploadConversationFile}) or via the
   * direct-SOP-API conversation IO routes.
   *
   * Layout: `<bff-root>/io/conversation/<Y>/<M>/<D>/<convId>/<filename>`.
   * The date layer is the conversation row's `createdAt` so a long-lived
   * conversation that spans UTC day boundaries keeps a single staging
   * directory.
   *
   * Only `forBff` is exposed — this directory is never mounted directly
   * into a sandbox; SOP bridge copies its contents into `sop-files/...`
   * at SOP start and the sandbox sees them at `/root/io/<sopExecId>/...`.
   */
  conversationIo: {
    forBff: (convId: string, createdAt: Date | string): string => {
      assertId('convId', convId)
      const [y, m, d] = dateLayerFromDate(createdAt)
      return bffJoin('io', 'conversation', y, m, d, convId)
    },
  },

  sharedLibs: {
    forBff: (): string => bffJoin('shared-libs', 'site-packages'),
    forSandbox: (): string => sbxJoin('shared-libs', 'site-packages'),
  },

  /**
   * Resolve a user-supplied relative path against a bff root and reject any
   * resolution that escapes the root. Returns absolute path or null.
   */
  safeResolve(bffRoot: string, relative: string): string | null {
    const resolved = path.resolve(bffRoot, relative)
    const normalizedRoot = path.resolve(bffRoot)
    const withSep = normalizedRoot + path.sep
    return resolved === normalizedRoot || resolved.startsWith(withSep) ? resolved : null
  },
}
