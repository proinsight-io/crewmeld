/**
 * @vitest-environment node
 *
 * Verifies that an OpenAI-compatible provider honors the per-request
 * `apiEndpoint` override (the custom "API 地址" from a model config) and falls
 * back to the provider's static `defaultBaseURL` when it is absent/blank.
 */
import { loggerMock } from '@crewmeld/testing'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@crewmeld/logger', () => loggerMock)

const mockCreate = vi.fn()

vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(() => ({
    chat: { completions: { create: mockCreate } },
  })),
}))

vi.mock('@/providers/utils', () => ({
  calculateCost: vi.fn().mockReturnValue({ input: 0, output: 0, total: 0 }),
  prepareToolExecution: vi.fn(),
  prepareToolsWithUsageControl: vi.fn().mockReturnValue({ tools: undefined, toolChoice: undefined }),
  trackForcedToolUsage: vi.fn(),
  createOpenAICompatibleStream: vi.fn(),
}))

vi.mock('@/lib/tools/execute-custom-skill', () => ({
  executeTool: vi.fn(),
}))

import OpenAI from 'openai'
import { createOpenAICompatibleProvider } from '@/providers/_openai-compat-factory'

const DEFAULT_BASE = 'https://default.example.com/v1'

function makeProvider() {
  return createOpenAICompatibleProvider({
    id: 'test-compat',
    name: 'TestCompat',
    description: 'test',
    defaultBaseURL: DEFAULT_BASE,
    defaultModel: 'test-model',
    logPrefix: 'TestCompat',
  })
}

function okResponse() {
  mockCreate.mockResolvedValueOnce({
    choices: [{ message: { content: 'ok', tool_calls: null } }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  })
}

describe('createOpenAICompatibleProvider — apiEndpoint override', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('falls back to defaultBaseURL when apiEndpoint is absent', async () => {
    okResponse()
    await makeProvider().executeRequest({
      model: 'test-model',
      apiKey: 'k',
      messages: [{ role: 'user', content: 'hi' }],
    } as never)
    expect(OpenAI).toHaveBeenCalledWith({ apiKey: 'k', baseURL: DEFAULT_BASE })
  })

  it('uses the per-request apiEndpoint when provided', async () => {
    okResponse()
    const custom = 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1'
    await makeProvider().executeRequest({
      model: 'test-model',
      apiKey: 'k',
      apiEndpoint: custom,
      messages: [{ role: 'user', content: 'hi' }],
    } as never)
    expect(OpenAI).toHaveBeenCalledWith({ apiKey: 'k', baseURL: custom })
  })

  it('trims whitespace and falls back to default on a blank apiEndpoint', async () => {
    okResponse()
    await makeProvider().executeRequest({
      model: 'test-model',
      apiKey: 'k',
      apiEndpoint: '   ',
      messages: [{ role: 'user', content: 'hi' }],
    } as never)
    expect(OpenAI).toHaveBeenCalledWith({ apiKey: 'k', baseURL: DEFAULT_BASE })
  })
})
