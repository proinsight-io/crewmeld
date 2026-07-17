import type { DevStudioEnv } from '../env'
import type { HostVolume } from '../opensandbox-client'
import { paths } from '../paths'
import type { CoderProvider, EntrypointOpts } from './types'

function volumeNameFor(prefix: string, sessionId: string): string {
  return `${prefix}-${sessionId}`.slice(0, 63)
}

function basicToken(env: DevStudioEnv): string | undefined {
  const pwd = env.OPENCODE_SERVER_PASSWORD
  if (!pwd) return undefined
  // Username defaults to "opencode" but can be overridden via OPENCODE_SERVER_USERNAME.
  return Buffer.from(`${env.OPENCODE_SERVER_USERNAME}:${pwd}`).toString('base64')
}

/** opencode serve backed coder. */
export const opencodeProvider: CoderProvider = {
  id: 'opencode',
  port: 4096,
  transport: 'rest-sse',
  image: (env) => env.CREWMELD_OPENCODE_IMAGE,
  buildEntrypoint: ({ env }: EntrypointOpts): string[] => {
    // Invoke the image's own entrypoint (git init + db seed + `opencode serve
    // --hostname 0.0.0.0 --cors '*'`), only overriding the port via env.
    return [
      '/bin/sh',
      '-c',
      `OPENCODE_PORT=${env.OPENCODE_PORT} exec /usr/local/bin/docker-entrypoint.sh`,
    ]
  },
  mounts: (sessionId: string): HostVolume[] => [
    {
      name: volumeNameFor('ws', sessionId),
      hostPath: paths.sessionWorkspace.forSandbox(sessionId),
      mountPath: '/root/workspace',
      readOnly: false,
    },
    {
      name: volumeNameFor('oc', sessionId),
      hostPath: paths.sessionOpencodeData.forSandbox(sessionId),
      mountPath: '/root/.local/share/opencode',
      readOnly: false,
    },
  ],
  authHeader: (env) => {
    const t = basicToken(env)
    return t ? { Authorization: `Basic ${t}` } : undefined
  },
  authQuery: (env) => basicToken(env),
}
