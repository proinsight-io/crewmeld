import { Label } from '@/components/ui/label'
import { getQwenCodingPlanId, QWEN_CODING_PLANS } from '@/lib/models/qwen-coding-plans'

interface QwenCodingPlanRadioProps {
  value: string
  onChange: (endpoint: string) => void
}

export function QwenCodingPlanRadio({ value, onChange }: QwenCodingPlanRadioProps) {
  const selectedPlanId = getQwenCodingPlanId(value)

  return (
    <div aria-label='Qwen Coding Plan' className='flex items-center gap-3'>
      {QWEN_CODING_PLANS.map((plan) => {
        const inputId = `qwen-coding-plan-${plan.id}`
        return (
          <Label
            key={plan.id}
            htmlFor={inputId}
            className='flex cursor-pointer items-center gap-1.5 font-normal text-sm'
          >
            <input
              id={inputId}
              type='radio'
              name='qwen-coding-plan'
              checked={selectedPlanId === plan.id}
              onChange={() => onChange(plan.endpoint)}
            />
            {plan.label}
          </Label>
        )
      })}
    </div>
  )
}
