'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { useTranslation } from '@/hooks/use-translation'
import type { OpencodePendingQuestion, OpencodeQuestionInfo } from '../hooks/use-opencode-stream'

/** Props for {@link OpencodeQuestionCard}. */
interface Props {
  question: OpencodePendingQuestion
  onSubmit: (answers: string[][]) => void
  onDismiss: () => void
}

/**
 * Renders a single question step of the wizard.
 *
 * Handles single-select (radio-style buttons), multi-select (checkboxes),
 * and an optional custom free-text textarea.
 */
function QuestionStep({
  info,
  answer,
  onChange,
}: {
  info: OpencodeQuestionInfo
  answer: string[]
  onChange: (next: string[]) => void
}): JSX.Element {
  const { t } = useTranslation()
  const showCustom = info.custom !== false
  // When the user types in the custom textarea, the answer for this question is the typed text
  const isCustomSelected = answer.length === 1 && !info.options.some((o) => o.label === answer[0])
  const [customText, setCustomText] = useState(isCustomSelected ? answer[0] : '')

  function toggleOption(label: string) {
    if (info.multiple) {
      if (answer.includes(label)) {
        onChange(answer.filter((a) => a !== label))
      } else {
        // Deselect custom input when selecting a predefined option
        onChange([...answer.filter((a) => info.options.some((o) => o.label === a)), label])
      }
    } else {
      // Single-select: replace answer; clear custom text
      setCustomText('')
      onChange([label])
    }
  }

  function handleCustomChange(text: string) {
    setCustomText(text)
    if (text.trim() === '') {
      onChange([])
    } else {
      onChange([text])
    }
  }

  return (
    <div className='flex flex-col gap-2'>
      {info.options.map((opt, idx) => {
        const selected = answer.includes(opt.label)
        if (info.multiple) {
          return (
            <label
              key={opt.label}
              className='flex items-start gap-2 cursor-pointer rounded-md border border-border px-3 py-2 hover:bg-accent/50 transition-colors'
              data-testid={`dev-studio:opencode-question:option:${idx}`}
            >
              <Checkbox
                checked={selected}
                onCheckedChange={() => toggleOption(opt.label)}
                className='mt-0.5 shrink-0'
              />
              <div className='flex flex-col min-w-0'>
                <span className='text-sm font-medium'>{opt.label}</span>
                {opt.description && (
                  <span className='text-xs text-muted-foreground'>{opt.description}</span>
                )}
              </div>
            </label>
          )
        }
        // Single-select: button-style radio
        return (
          <button
            key={opt.label}
            type='button'
            onClick={() => toggleOption(opt.label)}
            data-testid={`dev-studio:opencode-question:option:${idx}`}
            className={[
              'flex flex-col items-start text-left rounded-md border px-3 py-2 text-sm transition-colors',
              selected
                ? 'border-primary bg-primary/10 font-medium'
                : 'border-border hover:bg-accent/50',
            ].join(' ')}
          >
            <span className='font-medium'>{opt.label}</span>
            {opt.description && (
              <span className='text-xs text-muted-foreground'>{opt.description}</span>
            )}
          </button>
        )
      })}

      {showCustom && (
        <div className='flex flex-col gap-1'>
          <label className='text-xs text-muted-foreground'>
            {t('devStudio.opencode.question.customAnswer')}
          </label>
          <textarea
            className='w-full rounded-md border border-border bg-background px-3 py-2 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-ring'
            rows={2}
            placeholder={t('devStudio.opencode.question.customPlaceholder')}
            value={customText}
            onChange={(e) => handleCustomChange(e.target.value)}
          />
        </div>
      )}
    </div>
  )
}

/**
 * Interactive wizard card for a `question.asked` SSE event.
 *
 * Steps through each question one at a time; supports single-select,
 * multi-select, and custom free-text answers. Submits all answers together
 * when the operator reaches the last step and confirms.
 */
export function OpencodeQuestionCard({ question, onSubmit, onDismiss }: Props): JSX.Element {
  const total = question.questions.length
  const [step, setStep] = useState(0)
  const [answers, setAnswers] = useState<string[][]>(() => question.questions.map(() => []))

  const current = question.questions[step]
  const currentAnswer = answers[step] ?? []

  function setCurrentAnswer(next: string[]) {
    setAnswers((prev) => {
      const updated = [...prev]
      updated[step] = next
      return updated
    })
  }

  function handleNext() {
    if (step < total - 1) {
      setStep((s) => s + 1)
    }
  }

  function handleBack() {
    if (step > 0) {
      setStep((s) => s - 1)
    }
  }

  function handleSubmit() {
    onSubmit(answers)
  }

  const isLast = step === total - 1
  const isSingle = total === 1

  return (
    <div
      data-testid='dev-studio:opencode-question'
      className='rounded-md border border-blue-300 bg-blue-50 dark:border-blue-700 dark:bg-blue-950/30 p-3 text-sm flex flex-col gap-3 max-h-[55vh] overflow-y-auto'
    >
      {/* Header */}
      <div className='flex items-center justify-between gap-2'>
        <div className='flex flex-col gap-0.5'>
          {!isSingle && (
            <span className='text-xs text-muted-foreground'>
              第 {step + 1}/{total} 题
            </span>
          )}
          <span className='font-semibold'>{current.header}</span>
        </div>
        <button
          type='button'
          onClick={onDismiss}
          data-testid='dev-studio:opencode-question:dismiss'
          className='text-xs text-muted-foreground hover:text-foreground shrink-0'
        >
          忽略
        </button>
      </div>

      {/* Question text */}
      <p className='text-sm text-foreground'>{current.question}</p>

      {/* Options */}
      <QuestionStep info={current} answer={currentAnswer} onChange={setCurrentAnswer} />

      {/* Navigation — sticky so it stays visible when options overflow */}
      <div className='sticky bottom-0 bg-blue-50 dark:bg-blue-950/30 border-t border-blue-200 dark:border-blue-800 pt-2 -mx-3 px-3 -mb-3 pb-3'>
        <div className='flex items-center justify-between gap-2'>
          <div className='flex gap-2'>
            {!isSingle && step > 0 && (
              <Button type='button' size='sm' variant='outline' onClick={handleBack}>
                上一题
              </Button>
            )}
            {!isSingle && !isLast && (
              <Button
                type='button'
                size='sm'
                variant='outline'
                onClick={handleNext}
                data-testid='dev-studio:opencode-question:next'
              >
                下一题
              </Button>
            )}
          </div>
          {(isLast || isSingle) && (
            <Button
              type='button'
              size='sm'
              onClick={handleSubmit}
              data-testid='dev-studio:opencode-question:submit'
            >
              提交
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
