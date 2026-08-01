export const QWEN_CODING_PLANS = [
  {
    id: 'coding',
    label: 'Coding Plan',
    endpoint: 'https://coding.dashscope.aliyuncs.com/v1',
  },
  {
    id: 'token',
    label: 'Token Plan',
    endpoint: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
  },
] as const

export type QwenCodingPlanId = (typeof QWEN_CODING_PLANS)[number]['id']

export function getQwenCodingPlanId(endpoint: string): QwenCodingPlanId {
  return QWEN_CODING_PLANS.find((plan) => plan.endpoint === endpoint)?.id ?? 'coding'
}
