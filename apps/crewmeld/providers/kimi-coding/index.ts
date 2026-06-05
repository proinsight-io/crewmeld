import { createOpenAICompatibleProvider } from '@/providers/_openai-compat-factory'

export const kimiCodingProvider = createOpenAICompatibleProvider({
  id: 'kimi-coding',
  name: 'Kimi 编程',
  description: '月之暗面 Kimi 编程模型（OpenAI 兼容协议）',
  defaultBaseURL: 'https://api.moonshot.cn/v1',
  defaultModel: 'kimi-code-latest',
  models: ['kimi-code-latest', 'kimi-k2.5', 'moonshot-v1-8k'],
  logPrefix: 'KimiCoding',
})
