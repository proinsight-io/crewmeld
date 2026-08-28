/**
 * @vitest-environment node
 *
 * Tests for POST /sessions/:sessionId/fork — the "new iteration" flow.
 *
 * Regression: fork used to MOUNT the source adopted session's dirs while
 * leaving the new session id's host dir nonexistent. Because every host path is
 * re-derived from the session id (paths facade), run-test's code-sync then
 * failed with `ENOENT scandir sessions/<newId>/workspace`. Fork must instead
 * copy the source dirs into the new session's OWN dirs and mount those.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

// paths.ts reads these directly from process.env (not via getDevStudioEnv).
process.env.CREWMELD_BFF_VOLUME_ROOT = '/bff-root'
process.env.CREWMELD_SANDBOX_VOLUME_ROOT = '/sbx-root'

vi.mock('@/lib/dev-studio/env', () => ({
  getDevStudioEnv: () => ({
    OPENSANDBOX_SERVER_URL: 'http://opensandbox:8080',
    OPENSANDBOX_API_KEY: 'k',
    OPENSANDBOX_USE_PROXY: false,
    CREWMELD_SANDBOX_IMAGE: 'img',
    CREWMELD_OPENCODE_IMAGE: 'proinsight/crewmeld-coder2:latest',
    CREWMELD_SANDBOX_CPU: 1,
    CREWMELD_SANDBOX_MEMORY: 512,
    CREWMELD_SANDBOX_TTL_SECONDS: 7200,
    CREWMELD_PIP_INDEX_URL: undefined,
    ANTHROPIC_AUTH_TOKEN: 'tok',
    ANTHROPIC_BASE_URL: 'http://anthropic',
    ANTHROPIC_MODEL: 'm',
    ANTHROPIC_SMALL_FAST_MODEL: 'm-fast',
    OPENCODE_SERVER_PASSWORD: undefined,
    OPENCODE_PORT: 4096,
  }),
}))

const cpMock = vi.fn().mockResolvedValue(undefined)
const mkdirMock = vi.fn().mockResolvedValue(undefined)
const accessMock = vi.fn().mockResolvedValue(undefined)
vi.mock('node:fs/promises', () => ({
  cp: (...a: unknown[]) => cpMock(...a),
  mkdir: (...a: unknown[]) => mkdirMock(...a),
  access: (...a: unknown[]) => accessMock(...a),
}))

const createSandbox = vi.fn().mockResolvedValue({ id: 'sbx-new' })
const waitUntilRunning = vi.fn().mockResolvedValue(undefined)
const destroy = vi.fn().mockResolvedValue(undefined)
vi.mock('@/lib/dev-studio/opensandbox-client', () => ({
  OpenSandboxClient: class {
    createSandbox = createSandbox
    waitUntilRunning = waitUntilRunning
    destroy = destroy
  },
}))

const resolveModelEnvMock = vi.fn()
vi.mock('@/lib/dev-studio/model-resolver', () => ({
  resolveModelEnv: (...a: unknown[]) => resolveModelEnvMock(...a),
}))

const mockGetCurrentUserRole = vi.fn()
vi.mock('@/lib/auth/rbac/check-role', () => ({
  getCurrentUserRole: () => mockGetCurrentUserRole(),
}))

const storeList = vi.fn()
const storeCreate = vi.fn()
const storeUpdate = vi.fn()
vi.mock('@/lib/dev-studio/session-store', () => ({
  sessionStore: {
    list: (...a: unknown[]) => storeList(...a),
    create: (...a: unknown[]) => storeCreate(...a),
    update: (...a: unknown[]) => storeUpdate(...a),
  },
}))

import { paths } from '@/lib/dev-studio/paths'

const SOURCE_ID = '11111111-1111-4111-8111-111111111111'
const TOOL_ID = 'tool-abc'
const SOURCE_MODEL_CONFIG_ID = 'mc-source'

/** A fully-resolved model env mirroring resolveModelEnv's shape. */
const RESOLVED_MODEL_ENV = {
  modelConfigId: SOURCE_MODEL_CONFIG_ID,
  ANTHROPIC_AUTH_TOKEN: 'resolved-tok',
  ANTHROPIC_BASE_URL: 'http://resolved',
  ANTHROPIC_MODEL: 'resolved-model',
  ANTHROPIC_SMALL_FAST_MODEL: 'resolved-fast',
  displayLabel: '智谱编程 / glm-4.6',
}

function authed() {
  mockGetCurrentUserRole.mockResolvedValue({
    authenticated: true,
    userId: 'user-1',
    role: 'member',
    error: null,
  })
}

function forkReq(modelConfigId?: string | null) {
  return new Request('http://test/api/employee/dev-studio/sessions/src/fork', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      toolId: TOOL_ID,
      ...(modelConfigId === undefined ? {} : { modelConfigId }),
    }),
  })
}

const ctx = { params: Promise.resolve({ sessionId: 'src' }) }

describe('POST /sessions/:sessionId/fork', () => {
  beforeEach(() => {
    mockGetCurrentUserRole.mockReset()
    storeList.mockReset()
    storeCreate.mockReset()
    storeUpdate.mockReset().mockResolvedValue(undefined)
    cpMock.mockClear().mockResolvedValue(undefined)
    mkdirMock.mockClear().mockResolvedValue(undefined)
    accessMock.mockClear().mockResolvedValue(undefined)
    createSandbox.mockClear().mockResolvedValue({ id: 'sbx-new' })
    waitUntilRunning.mockClear().mockResolvedValue(undefined)
    destroy.mockClear()
    resolveModelEnvMock.mockReset().mockResolvedValue(RESOLVED_MODEL_ENV)
    // list() is queried 3×: adopted (source), active+toolId (conflict guard),
    // active (suspend preflight). Only the adopted query returns the source.
    storeList.mockImplementation(async (_userId: string, opts?: { status?: string }) => {
      if (opts?.status === 'adopted') {
        return [
          {
            id: SOURCE_ID,
            userId: 'user-1',
            toolId: TOOL_ID,
            status: 'adopted',
            workspaceDir: paths.sessionWorkspace.forBff(SOURCE_ID),
            claudeStateDir: paths.sessionClaude.forBff(SOURCE_ID),
            modelConfigId: SOURCE_MODEL_CONFIG_ID,
            modelName: '智谱编程 / glm-4.6',
          },
        ]
      }
      return []
    })
    storeCreate.mockImplementation(async (input: Record<string, unknown>) => ({ ...input }))
  })

  it('copies the source workspace into the new session dir and mounts the new id', async () => {
    authed()
    const { POST } = await import('./route')
    const res = await POST(forkReq(), ctx)
    expect(res.status).toBe(200)

    // The new row points at its OWN id-derived dirs, not the source's.
    const created = storeCreate.mock.calls[0][0] as {
      id: string
      workspaceDir: string
      claudeStateDir: string
    }
    const newId = created.id
    expect(newId).not.toBe(SOURCE_ID)
    expect(created.workspaceDir).toBe(paths.sessionWorkspace.forBff(newId))
    expect(created.claudeStateDir).toBe(paths.sessionClaude.forBff(newId))

    // Source workspace was copied INTO the new session's workspace.
    expect(cpMock).toHaveBeenCalledWith(
      paths.sessionWorkspace.forBff(SOURCE_ID),
      paths.sessionWorkspace.forBff(newId),
      { recursive: true }
    )

    // The sandbox mounts the NEW id's dirs (the bug mounted the source id while
    // the new id's dir never existed → run-test ENOENT).
    const sandboxArgs = createSandbox.mock.calls[0][0] as {
      volumes: Array<{ hostPath: string; mountPath: string }>
    }
    const wsVol = sandboxArgs.volumes.find((v) => v.mountPath === '/root/workspace')
    expect(wsVol?.hostPath).toBe(paths.sessionWorkspace.forSandbox(newId))
  })

  it('returns 500 (no sandbox, no row) when the source workspace copy fails', async () => {
    authed()
    cpMock.mockRejectedValueOnce(new Error('ENOENT'))
    const { POST } = await import('./route')
    const res = await POST(forkReq(), ctx)
    expect(res.status).toBe(500)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('workspace-copy-failed')
    expect(storeCreate).not.toHaveBeenCalled()
    expect(createSandbox).not.toHaveBeenCalled()
  })

  it('inherits the source session model: resolves it and injects the resolved env', async () => {
    authed()
    const { POST } = await import('./route')
    const res = await POST(forkReq(), ctx)
    expect(res.status).toBe(200)

    // The fork resolves credentials from the SOURCE session's pinned model,
    // not the global ANTHROPIC_* env.
    expect(resolveModelEnvMock).toHaveBeenCalledWith(SOURCE_MODEL_CONFIG_ID)

    // The spawned container uses the resolved token/model (not the env's 'tok'/'m').
    const sandboxArgs = createSandbox.mock.calls[0][0] as { env: Record<string, string> }
    expect(sandboxArgs.env.ANTHROPIC_AUTH_TOKEN).toBe('resolved-tok')
    expect(sandboxArgs.env.ANTHROPIC_MODEL).toBe('resolved-model')
    expect(sandboxArgs.env.ANTHROPIC_BASE_URL).toBe('http://resolved')
    expect(sandboxArgs.env.ANTHROPIC_SMALL_FAST_MODEL).toBe('resolved-fast')
  })

  it('uses an explicitly selected model instead of the adopted session model', async () => {
    authed()
    const { POST } = await import('./route')
    const res = await POST(forkReq('mc-new-model'), ctx)
    expect(res.status).toBe(200)
    expect(resolveModelEnvMock).toHaveBeenCalledWith('mc-new-model')
  })

  it('persists the inherited model on the new session row', async () => {
    authed()
    const { POST } = await import('./route')
    const res = await POST(forkReq(), ctx)
    expect(res.status).toBe(200)

    const created = storeCreate.mock.calls[0][0] as {
      modelConfigId: string | null
      modelName: string | null
    }
    expect(created.modelConfigId).toBe(SOURCE_MODEL_CONFIG_ID)
    expect(created.modelName).toBe(RESOLVED_MODEL_ENV.displayLabel)
  })

  it('persists the resolver-picked id when a "系统默认" source falls back (no global env)', async () => {
    authed()
    // Source tool was built with "系统默认" (modelConfigId = null). The operator
    // has since deleted the global env model, so the resolver auto-picks a real
    // coding config. The forked row must persist THAT picked id — not the null
    // input — otherwise the header model selector shows a blank.
    storeList.mockImplementation(async (_userId: string, opts?: { status?: string }) => {
      if (opts?.status === 'adopted') {
        return [
          {
            id: SOURCE_ID,
            userId: 'user-1',
            toolId: TOOL_ID,
            status: 'adopted',
            workspaceDir: paths.sessionWorkspace.forBff(SOURCE_ID),
            claudeStateDir: paths.sessionClaude.forBff(SOURCE_ID),
            modelConfigId: null,
            modelName: '系统默认',
          },
        ]
      }
      return []
    })
    resolveModelEnvMock.mockResolvedValueOnce({
      ...RESOLVED_MODEL_ENV,
      modelConfigId: 'mc-autopicked',
      displayLabel: '千帆编程 / qianfan-code-latest',
    })

    const { POST } = await import('./route')
    const res = await POST(forkReq(), ctx)
    expect(res.status).toBe(200)

    // Resolver was asked with the source's null input...
    expect(resolveModelEnvMock).toHaveBeenCalledWith(null)
    // ...but the row persists the EFFECTIVE picked id + its label.
    const created = storeCreate.mock.calls[0][0] as {
      modelConfigId: string | null
      modelName: string | null
    }
    expect(created.modelConfigId).toBe('mc-autopicked')
    expect(created.modelName).toBe('千帆编程 / qianfan-code-latest')
  })

  it('propagates Claude tier overrides from the resolved model env', async () => {
    authed()
    resolveModelEnvMock.mockResolvedValueOnce({
      ...RESOLVED_MODEL_ENV,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'haiku-x',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'sonnet-x',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'opus-x',
    })
    const { POST } = await import('./route')
    const res = await POST(forkReq(), ctx)
    expect(res.status).toBe(200)

    const sandboxArgs = createSandbox.mock.calls[0][0] as { env: Record<string, string> }
    expect(sandboxArgs.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('haiku-x')
    expect(sandboxArgs.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('sonnet-x')
    expect(sandboxArgs.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('opus-x')
  })

  it('returns 400 (no sandbox, no row) when the model cannot be resolved', async () => {
    authed()
    resolveModelEnvMock.mockRejectedValueOnce(new Error('Model config is disabled: mc-source'))
    const { POST } = await import('./route')
    const res = await POST(forkReq(), ctx)
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('model-resolve-failed')
    expect(storeCreate).not.toHaveBeenCalled()
    expect(createSandbox).not.toHaveBeenCalled()
  })

  it('forks an opencode session with coder2 image and opencode mounts', async () => {
    authed()
    storeList.mockImplementation(async (_userId: string, opts?: { status?: string }) => {
      if (opts?.status === 'adopted') {
        return [
          {
            id: SOURCE_ID,
            userId: 'user-1',
            toolId: TOOL_ID,
            status: 'adopted',
            coderType: 'opencode' as const,
            workspaceDir: paths.sessionWorkspace.forBff(SOURCE_ID),
            claudeStateDir: paths.sessionClaude.forBff(SOURCE_ID),
            modelConfigId: SOURCE_MODEL_CONFIG_ID,
            modelName: '智谱编程 / glm-4.6',
          },
        ]
      }
      return []
    })
    const { POST } = await import('./route')
    const res = await POST(forkReq(), ctx)
    expect(res.status).toBe(200)
    const call = createSandbox.mock.calls[0][0] as {
      image: string
      volumes: Array<{ mountPath: string }>
    }
    expect(call.image).toBe('proinsight/crewmeld-coder2:latest')
    // opencode mounts workspace + /root/.local/share/opencode, not /root/.claude/projects
    const mounts = call.volumes.map((v) => v.mountPath)
    expect(mounts).toContain('/root/workspace')
    expect(mounts).toContain('/root/.local/share/opencode')
    expect(mounts).not.toContain('/root/.claude/projects')
  })

  it('carries opencodeSessionId from the source session into the fork', async () => {
    // Arrange: source is an opencode-adopted session whose opencode.db was
    // already assigned a session id by the container runtime.  The fork copies
    // opencode.db so the new session MUST carry the same id to read history.
    authed()
    storeList.mockImplementation(async (_userId: string, opts?: { status?: string }) => {
      if (opts?.status === 'adopted') {
        return [
          {
            id: SOURCE_ID,
            userId: 'user-1',
            toolId: TOOL_ID,
            status: 'adopted',
            coderType: 'opencode' as const,
            opencodeSessionId: 'ses_src',
            workspaceDir: paths.sessionWorkspace.forBff(SOURCE_ID),
            claudeStateDir: paths.sessionClaude.forBff(SOURCE_ID),
            modelConfigId: SOURCE_MODEL_CONFIG_ID,
            modelName: '智谱编程 / glm-4.6',
          },
        ]
      }
      return []
    })

    const { POST } = await import('./route')
    const res = await POST(forkReq(), ctx)
    expect(res.status).toBe(200)

    // The new session row must carry the source's opencodeSessionId so that the
    // disk-history reader can match the copied opencode.db's session entry.
    expect(storeCreate).toHaveBeenCalledWith(
      expect.objectContaining({ coderType: 'opencode', opencodeSessionId: 'ses_src' })
    )
  })
})
