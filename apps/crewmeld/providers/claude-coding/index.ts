import { createOpenAICompatibleProvider } from '@/providers/_openai-compat-factory'

export const claudeCodingProvider = createOpenAICompatibleProvider({
  id: 'claude-coding',
  name: 'Claude 编程',
  description: 'Claude 编程模型',
  defaultBaseURL: 'https://api.anthropic.com/v1',
  defaultModel: 'claude-4-sonnet',
  models: ['claude-4-sonnet', 'claude-4-opus', 'claude-3-5-sonnet-20241022'],
  logPrefix: 'ClaudeCoding',
})
