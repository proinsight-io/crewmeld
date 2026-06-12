import { createOpenAICompatibleProvider } from '@/providers/_openai-compat-factory'

export const qwenCodingProvider = createOpenAICompatibleProvider({
  id: 'qwen-coding',
  name: '通义编程',
  description: '阿里云通义编程模型（Qwen Coder）',
  defaultBaseURL: 'https://dashscope.aliyuncs.com/apps/anthropic',
  defaultModel: 'qwen-code-latest',
  models: ['qwen-code-latest', 'qwen2.5-coder-32b-instruct', 'qwen3-max'],
  logPrefix: 'QwenCoding',
})
