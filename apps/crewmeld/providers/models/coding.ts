import { AliyunIcon, AnthropicIcon, BaiduIcon, MoonshotIcon } from '@/components/icons'
import type { ProviderDefinition } from '@/providers/models/types'

/** Provider definitions for coding-specialized LLM providers. */
export const codingProviders: Record<string, ProviderDefinition> = {
  'kimi-coding': {
    id: 'kimi-coding',
    name: 'Kimi 编程',
    description: '月之暗面 Kimi 编程模型（OpenAI 兼容协议）',
    defaultModel: 'kimi-code-latest',
    modelPatterns: [/^kimi/, /^moonshot/],
    icon: MoonshotIcon,
    category: 'coding',
    capabilities: { toolUsageControl: true },
    models: [
      { id: 'kimi-code-latest', pricing: { input: 0, output: 0, updatedAt: '2026-05-26' }, capabilities: {} },
      { id: 'kimi-k2.5', pricing: { input: 0, output: 0, updatedAt: '2026-05-26' }, capabilities: {} },
      { id: 'moonshot-v1-8k', pricing: { input: 0, output: 0, updatedAt: '2026-05-26' }, capabilities: {} },
    ],
  },
  'qianfan-coding': {
    id: 'qianfan-coding',
    name: '千帆编程',
    description: '百度千帆编程模型',
    defaultModel: 'qianfan-code-latest',
    modelPatterns: [/^qianfan-code/],
    icon: BaiduIcon,
    category: 'coding',
    capabilities: { toolUsageControl: true },
    models: [
      { id: 'qianfan-code-latest', pricing: { input: 0, output: 0, updatedAt: '2026-05-26' }, capabilities: {} },
    ],
  },
  'qwen-coding': {
    id: 'qwen-coding',
    name: '通义编程',
    description: '阿里云通义编程模型（Qwen Coder）',
    defaultModel: 'qwen-code-latest',
    modelPatterns: [/^qwen-code/, /^qwen.*coder/, /^qwen3/],
    icon: AliyunIcon,
    category: 'coding',
    capabilities: { toolUsageControl: true },
    models: [
      { id: 'qwen-code-latest', pricing: { input: 0, output: 0, updatedAt: '2026-05-26' }, capabilities: {} },
      { id: 'qwen2.5-coder-32b-instruct', pricing: { input: 0, output: 0, updatedAt: '2026-05-26' }, capabilities: {} },
      { id: 'qwen3-max', pricing: { input: 0, output: 0, updatedAt: '2026-05-26' }, capabilities: {} },
    ],
  },
  'claude-coding': {
    id: 'claude-coding',
    name: 'Claude 编程',
    description: 'Claude 编程模型',
    defaultModel: 'claude-4-sonnet',
    modelPatterns: [/^claude/],
    icon: AnthropicIcon,
    category: 'coding',
    capabilities: { toolUsageControl: true },
    models: [
      { id: 'claude-4-sonnet', pricing: { input: 0, output: 0, updatedAt: '2026-05-26' }, capabilities: {} },
      { id: 'claude-4-opus', pricing: { input: 0, output: 0, updatedAt: '2026-05-26' }, capabilities: {} },
      { id: 'claude-3-5-sonnet-20241022', pricing: { input: 0, output: 0, updatedAt: '2026-05-26' }, capabilities: {} },
    ],
  },
}
