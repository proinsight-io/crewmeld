import type { DevStudioEnv } from '../env'
import type { HostVolume } from '../opensandbox-client'

/** Options passed when building a coder's container entrypoint. */
export interface EntrypointOpts {
  env: DevStudioEnv
  pipIndexUrl?: string
}

/** A pluggable coding-agent backend that runs inside an OpenSandbox container. */
export interface CoderProvider {
  /** Stable identifier persisted on tool_dev_sessions.coderType. */
  id: 'claudecode' | 'opencode'
  /** In-container port the coder's HTTP server listens on. */
  port: number
  /** Resolve the OCI image for this coder from env. */
  image(env: DevStudioEnv): string
  /** Build the container entrypoint argv. */
  buildEntrypoint(opts: EntrypointOpts): string[]
  /** Bind mounts (sandbox-side hostPath) for a given session. */
  mounts(sessionId: string): HostVolume[]
  /** How the BFF talks to this coder. */
  transport: 'ndjson' | 'rest-sse'
  /** HTTP Basic header for REST calls, or undefined when auth disabled. */
  authHeader(env: DevStudioEnv): Record<string, string> | undefined
  /** auth_token query value for SSE (EventSource cannot set headers), or undefined. */
  authQuery(env: DevStudioEnv): string | undefined
}
