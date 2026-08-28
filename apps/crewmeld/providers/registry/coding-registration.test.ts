import { describe, expect, it } from 'vitest'
import type { ProviderId } from '@/providers/types'
import { providers } from '@/providers/utils/registry'
import { codingProviders } from '@/providers/models/coding'
import { getTierFor } from './core'

/**
 * Coding-specialized providers (used by the dev-studio model selector and the
 * planned `GET /models?category=coding` filter) are part of the ProviderId
 * union, so every exhaustive `Record<ProviderId, …>` must cover them. These
 * tests guard the two non-partial maps that previously omitted them.
 */
const CODING_PROVIDER_IDS: ProviderId[] = [
  'claude-coding',
  'kimi-coding',
  'qianfan-coding',
  'qwen-coding',
  'zhipu-coding',
]

describe('coding provider registration', () => {
  it('exposes every coding provider in the metadata registry', () => {
    for (const id of CODING_PROVIDER_IDS) {
      expect(providers[id], `providers['${id}'] should be registered`).toBeDefined()
      expect(providers[id].name.length).toBeGreaterThan(0)
    }
  })

  it('assigns a non-fallback SLA tier to every coding provider', () => {
    // getTierFor falls back to 'experimental' for unmapped ids; coding
    // providers must be explicitly classified, mirroring their base vendor.
    expect(getTierFor('claude-coding')).toBe('enterprise')
    expect(getTierFor('qwen-coding')).toBe('enterprise')
    expect(getTierFor('qianfan-coding')).toBe('enterprise')
    expect(getTierFor('kimi-coding')).toBe('standard')
    expect(getTierFor('zhipu-coding')).toBe('standard')
  })

  it('declares OpenAI-compatible endpoints for Qianfan and Zhipu coding', () => {
    expect(codingProviders['qianfan-coding']).toMatchObject({
      codingProtocol: 'openai-compatible',
      defaultEndpoint: 'https://qianfan.baidubce.com/v2/coding',
    })
    expect(codingProviders['zhipu-coding']).toMatchObject({
      codingProtocol: 'openai-compatible',
      defaultEndpoint: 'https://open.bigmodel.cn/api/coding/paas/v4',
    })
  })
})
