'use client'

import type React from 'react'
import { MessageCircleQuestion } from 'lucide-react'
import { BasicTool } from '../basic-tool'
import { defaultTranslate } from '../tool-info'
import type { ToolProps } from './registry'

/** A single question item with its answer. */
interface QuestionItem {
  question: string
}

/**
 * Narrows an unknown value to a string array if possible.
 */
function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((v) => String(v))
}

/**
 * Narrows an unknown value to a QuestionItem array.
 */
function toQuestionItems(value: unknown): QuestionItem[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((v): v is Record<string, unknown> => typeof v === 'object' && v !== null)
    .map((v) => ({ question: String(v['question'] ?? '') }))
}

/**
 * Renderer for the `question` tool.
 * Opens by default once answered (metadata.answers populated).
 */
export function questionTool(props: ToolProps): React.JSX.Element {
  const { input, metadata, status, hideDetails, t = defaultTranslate } = props

  const answers = toStringArray(metadata?.answers)
  const questions = toQuestionItems(input.questions)
  const answered = answers.length > 0

  const subtitle = answered
    ? t('devStudio.opencode.question.answered', { count: answers.length })
    : t('devStudio.opencode.question.count', { count: questions.length })

  return (
    <BasicTool
      icon={MessageCircleQuestion}
      trigger={{ title: t('devStudio.opencode.tool.question'), subtitle }}
      status={status}
      hideDetails={hideDetails}
      defaultOpen={answered}
      data-testid='opencode-message:tool:question'
    >
      {answered && (
        <ul className='space-y-1.5 text-xs'>
          {questions.map((q, i) => (
            // eslint-disable-next-line react/no-array-index-key
            <li key={i} className='space-y-0.5'>
              <div className='font-medium text-foreground'>{q.question}</div>
              <div className='text-muted-foreground'>{answers[i] ?? ''}</div>
            </li>
          ))}
        </ul>
      )}
    </BasicTool>
  )
}
