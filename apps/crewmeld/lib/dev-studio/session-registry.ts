import type { SessionInfo } from './schemas'

interface DestroyClient {
  destroy(sandboxId: string): Promise<void>
}

/**
 * In-process map of sessionId → SessionInfo.
 *
 * A.min: not persisted. Lost on BFF restart. OpenSandbox TTL (2h) bounds leakage.
 *
 * @deprecated Sub-spec B replaces this with the DB-backed `session-store.ts`.
 *   Kept for A.min back-compat until all routes migrate; do not add new callers.
 *
 * Singleton instance exported as `sessionRegistry` for shared use across route handlers.
 */
export class SessionRegistry {
  private readonly map = new Map<string, SessionInfo>()

  set(id: string, info: SessionInfo): void {
    this.map.set(id, info)
  }

  get(id: string): SessionInfo | undefined {
    return this.map.get(id)
  }

  delete(id: string): boolean {
    return this.map.delete(id)
  }

  size(): number {
    return this.map.size
  }

  /**
   * Best-effort cleanup of all sandboxes. Used on process SIGTERM/SIGINT.
   * Continues despite individual destroy failures.
   */
  async destroyAll(client: DestroyClient): Promise<void> {
    const entries = [...this.map.values()]
    this.map.clear()
    await Promise.allSettled(entries.map((s) => client.destroy(s.sandboxId)))
  }
}

export const sessionRegistry = new SessionRegistry()
