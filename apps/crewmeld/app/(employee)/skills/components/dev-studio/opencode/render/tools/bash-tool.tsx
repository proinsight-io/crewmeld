'use client'

import type React from 'react'
import { useState } from 'react'
import { Check, Copy, Terminal } from 'lucide-react'
import { copyToClipboard } from '@/lib/core/utils/clipboard'
import { useTranslation } from '@/hooks/use-translation'
import { BasicTool } from '../basic-tool'
import { defaultTranslate } from '../tool-info'
import type { ToolProps } from './registry'

/** Strips ANSI color/style escape codes from a string. */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, '')
}

/** Normalizes Windows line endings to Unix. */
function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

/** Copy button that toggles a checkmark icon on success. */
function CopyButton({ text }: { text: string }): React.JSX.Element {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)

  async function handleCopy(): Promise<void> {
    await copyToClipboard(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <button
      type='button'
      onClick={handleCopy}
      aria-label={t('devStudio.opencode.tool.copyCommand')}
      className='shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground'
    >
      {copied ? <Check className='h-3 w-3 text-green-500' /> : <Copy className='h-3 w-3' />}
    </button>
  )
}

/**
 * Renderer for the `bash` tool.
 * Shows the shell command and output (ANSI stripped) in an expandable pre block.
 */
export function bashTool(props: ToolProps): React.JSX.Element {
  const { input, metadata, output, status, hideDetails, t = defaultTranslate } = props

  const command = String(input.command ?? metadata?.command ?? '')
  const description = input.description ? String(input.description) : undefined

  const rawOutput = output ?? ''
  const cleanOutput = normalizeLineEndings(stripAnsi(rawOutput))

  const content = `$ ${command}${cleanOutput ? `\n\n${cleanOutput}` : ''}`

  return (
    <BasicTool
      icon={Terminal}
      trigger={{ title: t('devStudio.opencode.tool.bash'), subtitle: description }}
      status={status}
      hideDetails={hideDetails}
      data-testid='opencode-message:tool:bash'
    >
      <div className='relative'>
        <div className='absolute right-1 top-1'>
          <CopyButton text={content} />
        </div>
        <pre className='overflow-x-auto rounded bg-muted px-3 py-2 pr-6 text-xs font-mono'>
          <code>{content}</code>
        </pre>
      </div>
    </BasicTool>
  )
}
