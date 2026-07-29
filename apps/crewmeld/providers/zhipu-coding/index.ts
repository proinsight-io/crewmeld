import { createOpenAICompatibleProvider } from '@/providers/_openai-compat-factory'

export const zhipuCodingProvider = createOpenAICompatibleProvider({
  id: 'zhipu-coding',
  name: '智谱 GLM 编程',
  description: '智谱 GLM Coding 模型（OpenAI 兼容协议）',
  defaultBaseURL: 'https://open.bigmodel.cn/api/paas/v4/',
  defaultModel: 'glm-5.2',
  models: ['glm-5.2', 'GLM-5', 'glm-4.7'],
  logPrefix: 'ZhipuCoding',
})
