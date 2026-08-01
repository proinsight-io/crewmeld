import { createOpenAICompatibleProvider } from '@/providers/_openai-compat-factory'

export const qianfanCodingProvider = createOpenAICompatibleProvider({
  id: 'qianfan-coding',
  name: '千帆编程',
  description: '百度千帆编程模型',
  defaultBaseURL: 'https://qianfan.baidubce.com/v2/coding',
  defaultModel: 'qianfan-code-latest',
  models: ['qianfan-code-latest'],
  logPrefix: 'QianfanCoding',
})
