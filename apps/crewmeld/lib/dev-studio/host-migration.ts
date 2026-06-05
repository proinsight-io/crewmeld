/**
 * One-shot startup migration: A.min → B host directory layout (Sub-spec B §9).
 *
 * Sub-spec A stored each session's workspace directly under
 * `<bff sessions root>/<sessionId>/`. Sub-spec B nests two siblings
 * under the same per-session directory:
 *
 *   <bff sessions root>/<sessionId>/workspace/  ← actual workspace
 *                                                 (paths.sessionWorkspace.forBff)
 *   <bff sessions root>/<sessionId>/claude/     ← host end of
 *                                                 /root/.claude/projects
 *                                                 (SDK resume state — paths.sessionClaude.forBff)
 *
 * On BFF startup we walk the sessions root and migrate every legacy session
 * into the new layout. The migration is idempotent: a session that already
 * contains a `workspace/` subdirectory is treated as already-migrated and
 * skipped. Failures for one session never block another — each migration is
 * isolated in its own try/catch so a single bad apple doesn't ruin startup.
 *
 * Algorithm (per legacy session):
 *   1. Stage `<root>/<id>/`           → `<root>/<id>.migrating/workspace/`
 *      (rename within the same parent → atomic on POSIX & NTFS)
 *   2. Recreate `<root>/<id>/`
 *   3. Rename `<root>/<id>.migrating/workspace/` → `<root>/<id>/workspace/`
 *      (target derived via {@link paths.sessionWorkspace.forBff})
 *   4. mkdir `<root>/<id>/claude/`
 *      (target derived via {@link paths.sessionClaude.forBff})
 *   5. rmdir `<root>/<id>.migrating/`
 *
 * Staging inside the sessions root (instead of the OS temp dir) keeps the
 * rename intra-filesystem so it's atomic. We use a sibling name suffixed with
 * `.migrating` to make any crash-mid-migration state human-debuggable.
 *
 * The root is derived from {@link paths.bffSessionsRoot} (i.e.
 * `CREWMELD_BFF_VOLUME_ROOT/sessions`); the legacy `CREWMELD_SESSIONS_DIR`
 * env var is no longer consulted. See spec
 * 2026-05-28-cross-platform-nfs-volume-design.md §12.5.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { createLogger } from '@crewmeld/logger'
import { paths } from './paths'

const log = createLogger('dev-studio:host-migration')

/** Suffix appended to the per-session directory name during in-flight migration. */
const STAGING_SUFFIX = '.migrating'

export interface HostMigrationResult {
  /** Session ids that were converted from A.min layout to B layout. */
  migrated: string[]
  /** Session ids already in B layout — left untouched. */
  skipped: string[]
  /** Per-session failures. Other sessions in the batch are unaffected. */
  errors: Array<{ sessionId: string; error: Error }>
}

/**
 * Walk the BFF sessions root, migrating each legacy session directory in
 * place. The root is sourced from {@link paths.bffSessionsRoot} so the
 * function picks up `CREWMELD_BFF_VOLUME_ROOT` at call time — no params.
 *
 * Non-directory top-level entries are ignored. A missing sessions root returns
 * an empty result (cold-start case). Catastrophic failures while listing the
 * root propagate to the caller; per-session failures are captured in
 * {@link HostMigrationResult.errors}.
 */
export async function migrateAMinHostDirs(): Promise<HostMigrationResult> {
  const sessionsRoot = paths.bffSessionsRoot()
  const result: HostMigrationResult = { migrated: [], skipped: [], errors: [] }

  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(sessionsRoot, { withFileTypes: true })
  } catch (err: unknown) {
    if (isEnoent(err)) return result
    throw err
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const sessionId = entry.name
    // Skip any leftover staging dirs from a previous interrupted run.
    if (sessionId.endsWith(STAGING_SUFFIX)) continue

    const sessionDir = path.join(sessionsRoot, sessionId)
    try {
      const alreadyB = await dirExists(path.join(sessionDir, 'workspace'))
      if (alreadyB) {
        result.skipped.push(sessionId)
        continue
      }
      await migrateOne(sessionsRoot, sessionId)
      result.migrated.push(sessionId)
      log.info('migrated A.min session to B layout', { sessionId })
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      result.errors.push({ sessionId, error })
      log.error('host migration failed for session', {
        sessionId,
        err: error.stack ?? error.message,
      })
    }
  }

  return result
}

/** Move a single A.min session into the B layout. */
async function migrateOne(sessionsRoot: string, sessionId: string): Promise<void> {
  const sessionDir = path.join(sessionsRoot, sessionId)
  const stagingDir = path.join(sessionsRoot, sessionId + STAGING_SUFFIX)
  const stagingWorkspace = path.join(stagingDir, 'workspace')

  // Defensive: a leftover staging dir from a prior crashed run would collide.
  // Surface as an error rather than guess at recovery.
  if (await pathExists(stagingDir)) {
    throw new Error(
      `staging directory already exists: ${stagingDir} — manual cleanup required before retry`
    )
  }

  // Step 1: park the legacy session under <id>.migrating/workspace/
  await fs.mkdir(stagingDir, { recursive: false })
  await fs.rename(sessionDir, stagingWorkspace)

  // Step 2 + 3: recreate <id>/ and move workspace/ back into place.
  // Target workspace path is derived via the paths facade so any future shift
  // in the BFF layout (e.g. extra sub-segment) lands consistently.
  await fs.mkdir(sessionDir, { recursive: false })
  await fs.rename(stagingWorkspace, paths.sessionWorkspace.forBff(sessionId))

  // Step 4: claude/ starts empty — the SDK will populate it on first chat.
  await fs.mkdir(paths.sessionClaude.forBff(sessionId), { recursive: false })

  // Step 5: tear down staging.
  await fs.rmdir(stagingDir)
}

async function dirExists(p: string): Promise<boolean> {
  try {
    const s = await fs.stat(p)
    return s.isDirectory()
  } catch (err) {
    if (isEnoent(err)) return false
    throw err
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p)
    return true
  } catch (err) {
    if (isEnoent(err)) return false
    throw err
  }
}

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ENOENT'
}
