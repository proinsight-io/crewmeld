'use client'

import type React from 'react'
import type { Components } from 'react-markdown'
import ReactMarkdown from 'react-markdown'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'
import { cn } from '@/lib/core/utils/cn'

/** Minimal components map for opencode markdown rendering. */
const markdownComponents: Components = {
  code({ className, children, ...props }) {
    const isBlock = String(children).includes('\n')
    if (isBlock) {
      return (
        <pre className='my-2 overflow-auto rounded-lg bg-gray-900 p-3 font-mono text-gray-100 text-xs leading-5'>
          <code className={className} {...props}>
            {children}
          </code>
        </pre>
      )
    }
    return (
      <code
        className='rounded bg-muted px-1 py-0.5 font-mono text-muted-foreground text-xs'
        {...props}
      >
        {children}
      </code>
    )
  },
  a({ href, children }) {
    return (
      <a
        href={href}
        target='_blank'
        rel='noopener noreferrer'
        className='text-blue-600 underline hover:text-blue-800'
      >
        {children}
      </a>
    )
  },
  ul({ children }) {
    return <ul className='my-1 list-disc space-y-0.5 pl-5'>{children}</ul>
  },
  ol({ children }) {
    return <ol className='my-1 list-decimal space-y-0.5 pl-5'>{children}</ol>
  },
  blockquote({ children }) {
    return (
      <blockquote className='my-2 border-blue-400 border-l-4 pl-3 text-muted-foreground italic'>
        {children}
      </blockquote>
    )
  },
  table({ children }) {
    return (
      <div className='my-2 overflow-x-auto rounded-lg border'>
        <table className='min-w-full text-xs'>{children}</table>
      </div>
    )
  },
}

/**
 * OpencodeMarkdown — thin react-markdown wrapper with GFM and breaks plugins.
 * Styled for the opencode chat surface.
 */
export function OpencodeMarkdown({
  text,
  className,
}: {
  text: string
  className?: string
}): React.JSX.Element {
  return (
    <div className={cn('prose prose-sm max-w-none text-sm', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={markdownComponents}>
        {text}
      </ReactMarkdown>
    </div>
  )
}
