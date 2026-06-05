'use client'

import { useEffect, useState } from 'react'
import { type DevStudioLocale, filterCommands } from '@/lib/dev-studio/slash-commands'
import { useTranslation } from '@/hooks/use-translation'

interface Props {
  /** Open when input matches `/^\/(\S*)$/`. */
  open: boolean
  /** The query after the `/` (could be empty for showing all). */
  query: string
  /** Called with the english command name (no `/` prefix). */
  onSelect: (englishName: string) => void
  /** Called when user presses Escape inside menu. */
  onClose: () => void
}

export function SlashCommandMenu({ open, query, onSelect, onClose }: Props) {
  const { locale } = useTranslation()
  const effectiveLocale: DevStudioLocale = locale === 'en' ? 'en' : 'zh-CN'
  const candidates = filterCommands(query, effectiveLocale)
  const [highlight, setHighlight] = useState(0)

  useEffect(() => {
    setHighlight(0)
  }, [query, open])

  useEffect(() => {
    if (!open || candidates.length === 0) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setHighlight((h) => (h + 1) % candidates.length)
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setHighlight((h) => (h - 1 + candidates.length) % candidates.length)
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        onSelect(candidates[highlight].englishName)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [open, candidates, highlight, onSelect, onClose])

  if (!open || candidates.length === 0) return null

  return (
    <div
      className='absolute bottom-full left-3 right-3 mb-2 max-w-[480px] rounded-md border bg-popover shadow-md z-10'
      role='listbox'
      data-testid='dev-studio:slash-command-menu'
    >
      <div className='py-1 max-h-72 overflow-y-auto'>
        {candidates.map((cmd, idx) => (
          <div
            key={cmd.englishName}
            role={'option' as const}
            aria-selected={idx === highlight}
            data-testid={`dev-studio:slash-command-item:${cmd.englishName}`}
            className={
              idx === highlight
                ? 'flex flex-col items-start gap-0.5 px-3 py-2 cursor-pointer bg-accent'
                : 'flex flex-col items-start gap-0.5 px-3 py-2 cursor-pointer hover:bg-accent/50'
            }
            onMouseEnter={() => setHighlight(idx)}
            onClick={() => onSelect(cmd.englishName)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onSelect(cmd.englishName)
            }}
            tabIndex={-1}
          >
            <span className='font-mono text-sm font-medium'>
              /{cmd.localizedNames[effectiveLocale]}
            </span>
            <span className='text-xs text-muted-foreground'>
              {cmd.descriptions[effectiveLocale]}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
