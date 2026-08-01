import { createOpenAICompatibleProvider } from '@/providers/_openai-compat-factory'

export const kimiCodingProvider = createOpenAICompatibleProvider({
  id: 'kimi-coding',
  name: 'Kimi 编程',
  description: '月之暗面 Kimi 编程模型（OpenAI 兼容协议）',
  defaultBaseURL: 'https://api.kimi.com/coding/v1',
  defaultModel: 'kimi-for-coding',
  models: ['kimi-for-coding', 'kimi-for-coding-highspeed'],
  logPrefix: 'KimiCoding',
})
