import type { HostVolume } from '../opensandbox-client'
import { paths } from '../paths'
import type { CoderProvider, EntrypointOpts } from './types'

const PORT = 8080

function volumeNameFor(prefix: string, sessionId: string): string {
  return `${prefix}-${sessionId}`.slice(0, 63)
}

/** claude-code-webui backed coder (legacy default). */
export const claudecodeProvider: CoderProvider = {
  id: 'claudecode',
  port: PORT,
  transport: 'ndjson',
  image: (env) => env.CREWMELD_SANDBOX_IMAGE,
  buildEntrypoint: ({ pipIndexUrl }: EntrypointOpts): string[] => {
    if (!pipIndexUrl) return ['claude-code-webui', '--host', '0.0.0.0', '--port', String(PORT)]
    const launch = `exec claude-code-webui --host 0.0.0.0 --port ${PORT}`
    const trustedHost = new URL(pipIndexUrl).host
    const setup = `mkdir -p /root/.pip && printf '[global]\\nindex-url=%s\\ntrusted-host=%s\\n' '${pipIndexUrl}' '${trustedHost}' > /root/.pip/pip.conf`
    return ['/bin/sh', '-c', `${setup} && ${launch}`]
  },
  mounts: (sessionId: string): HostVolume[] => [
    {
      name: volumeNameFor('ws', sessionId),
      hostPath: paths.sessionWorkspace.forSandbox(sessionId),
      mountPath: '/root/workspace',
      readOnly: false,
    },
    {
      name: volumeNameFor('cl', sessionId),
      hostPath: paths.sessionClaude.forSandbox(sessionId),
      mountPath: '/root/.claude/projects',
      readOnly: false,
    },
  ],
  authHeader: () => undefined,
  authQuery: () => undefined,
}
