import { createOpenAICompatibleProvider } from '@/providers/_openai-compat-factory'

export const qwenCodingProvider = createOpenAICompatibleProvider({
  id: 'qwen-coding',
  name: '通义编程',
  description: '阿里云通义编程模型（Qwen Coder）',
  defaultBaseURL: 'https://coding.dashscope.aliyuncs.com/v1',
  defaultModel: 'qwen3-coder-plus',
  models: ['qwen3-coder-plus', 'qwen3-coder-next'],
  logPrefix: 'QwenCoding',
})
