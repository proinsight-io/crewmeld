'use client'
import { type ReactElement, useState } from 'react'
import { CheckSquare, ChevronDown, ChevronUp, Circle, Loader2, Square } from 'lucide-react'
import { useTranslation } from '@/hooks/use-translation'
import type { OpencodeTodo } from '../hooks/use-opencode-stream'

interface Props {
  todos: OpencodeTodo[]
  /** When true and there are still incomplete todos, a spinner is shown next to the progress count. */
  busy?: boolean
}

/**
 * Live todo dock that mirrors opencode's SessionTodoDock UX.
 * - Empty list → renders nothing.
 * - Collapsed (default): compact bar with progress + active todo preview.
 * - Expanded: full list with per-status styles.
 */
export function OpencodeTodoPanel({ todos, busy }: Props): ReactElement | null {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)

  if (todos.length === 0) return null

  const doneCount = todos.filter((t) => t.status === 'completed').length
  const activeTodo = pickActiveTodo(todos)

  // Show the spinner only while AI is working and there are still incomplete todos.
  const showSpinner = (busy ?? false) && doneCount < todos.length

  return (
    <div
      className='mx-3 mb-1 rounded-md border bg-muted/30 text-xs'
      data-testid='dev-studio:opencode-todo-panel'
    >
      {/* Toggle bar — always visible */}
      <button
        type='button'
        className='flex w-full items-center gap-2 px-3 py-2 text-left'
        onClick={() => setExpanded((v) => !v)}
        data-testid='dev-studio:opencode-todo:toggle'
      >
        <span className='font-medium text-muted-foreground shrink-0'>
          {t('devStudio.opencode.todo.done', { done: doneCount, total: todos.length })}
        </span>
        {showSpinner && (
          <Loader2
            className='h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground'
            data-testid='dev-studio:opencode-todo:spinner'
          />
        )}
        {activeTodo && !expanded && (
          <span className='min-w-0 flex-1 truncate text-foreground'>{activeTodo.content}</span>
        )}
        <span className='ml-auto shrink-0 text-muted-foreground'>
          {expanded ? <ChevronDown className='h-3 w-3' /> : <ChevronUp className='h-3 w-3' />}
        </span>
      </button>

      {/* Expanded full list */}
      {expanded && (
        <ul className='space-y-1 border-t px-3 pb-2 pt-1.5'>
          {todos.map((todo, idx) => (
            <TodoRow key={idx} todo={todo} idx={idx} />
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * Pick the single "active" todo to preview in collapsed state.
 * Priority: first in_progress → first pending → last completed.
 */
function pickActiveTodo(todos: OpencodeTodo[]): OpencodeTodo | null {
  const inProgress = todos.find((t) => t.status === 'in_progress')
  if (inProgress) return inProgress
  const pending = todos.find((t) => t.status === 'pending')
  if (pending) return pending
  const completed = todos.filter((t) => t.status === 'completed')
  return completed.length > 0 ? (completed[completed.length - 1] ?? null) : null
}

function TodoRow({ todo, idx }: { todo: OpencodeTodo; idx: number }): ReactElement {
  return (
    <li className='flex items-start gap-1.5' data-testid={`dev-studio:opencode-todo:${idx}`}>
      <TodoStatusIcon status={todo.status} />
      <span className={todoTextClass(todo.status)}>{todo.content}</span>
    </li>
  )
}

function TodoStatusIcon({ status }: { status: string }): ReactElement {
  switch (status) {
    case 'completed':
      return <CheckSquare className='mt-px h-3 w-3 shrink-0 text-green-600' />
    case 'in_progress':
      // Pulsing indicator dot for active work
      return (
        <span
          aria-hidden='true'
          className='mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-blue-500 animate-pulse'
        />
      )
    case 'cancelled':
      return <Square className='mt-px h-3 w-3 shrink-0 text-muted-foreground' />
    default:
      // pending
      return <Circle className='mt-px h-3 w-3 shrink-0 text-muted-foreground' />
  }
}

function todoTextClass(status: string): string {
  switch (status) {
    case 'completed':
      return 'line-through text-muted-foreground'
    case 'cancelled':
      return 'line-through text-muted-foreground'
    case 'in_progress':
      return 'text-foreground font-medium'
    default:
      return 'text-foreground'
  }
}
