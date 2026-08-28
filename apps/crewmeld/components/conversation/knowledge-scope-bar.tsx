'use client'

import { BookOpen } from 'lucide-react'
import { cn } from '@/lib/core/utils/cn'
import type { ChatKnowledgeBase } from '@/lib/conversation/chat-knowledge'

interface KnowledgeScopeBarProps {
  datasets: ChatKnowledgeBase[]
  selectedIds: string[]
  onChange: (ids: string[]) => void
}

export function KnowledgeScopeBar({ datasets, selectedIds, onChange }: KnowledgeScopeBarProps) {
  if (datasets.length === 0) return null

  const select = (id: string) => onChange([id])

  return (
    <div className='border-gray-200 border-b bg-white px-4 py-2' data-testid='chat:knowledge:bar'>
      <div className='mx-auto flex max-w-3xl items-center gap-2'>
        <BookOpen className='h-4 w-4 shrink-0 text-gray-400' />
        <div className='flex min-w-0 flex-1 gap-2 overflow-x-auto overscroll-x-contain pb-1'>
          <button
            type='button'
            aria-pressed={selectedIds.length === 0}
            data-testid='chat:knowledge:all'
            onClick={() => onChange([])}
            className={cn(
              'shrink-0 rounded-full border px-3 py-1 text-xs transition-colors',
              selectedIds.length === 0
                ? 'border-blue-600 bg-blue-600 text-white'
                : 'border-gray-200 bg-white text-gray-600 hover:border-blue-300'
            )}
          >
            全部知识库
          </button>
          {datasets.map((dataset) => {
            const selected = selectedIds.includes(dataset.id)
            return (
              <button
                type='button'
                key={dataset.id}
                aria-pressed={selected}
                data-testid={`chat:knowledge:${dataset.id}`}
                onClick={() => select(dataset.id)}
                className={cn(
                  'shrink-0 rounded-full border px-3 py-1 text-xs transition-colors',
                  selected
                    ? 'border-blue-600 bg-blue-50 text-blue-700'
                    : 'border-gray-200 bg-white text-gray-600 hover:border-blue-300'
                )}
              >
                {dataset.name}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
